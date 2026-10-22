/**
 * JobManager: background commands and watches, each run under a supervisor in its own
 * process group (see supervisor.ts for why). No pi imports — the pi adapter (extension.ts)
 * only translates tools, messages and delivery.
 *
 * Every job reaches exactly one terminal state (see `settle`). `onTerminal` fires once for
 * it, except for jobs stopped by `kill()` or `shutdown()`, whose caller already knows.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LOG_CAP_BYTES, LogWriter } from "./logwriter.ts";
import { SupervisedRun, type RunOutcome } from "./supervisor.ts";
import { readTail, tailBuffer, TailSink, type Tail } from "./tail.ts";
import { evaluateWatch, type CheckResult, type WatchUntil } from "./watch.ts";

export type JobKind = "command" | "watch";
export type JobStatus = "running" | "succeeded" | "failed" | "timed_out" | "killed" | "matched";

export interface JobSnapshot {
	id: string;
	kind: JobKind;
	label?: string;
	/** The command, or the check command for a watch. */
	command: string;
	cwd: string;
	logPath: string;
	startedAt: number;
	endedAt?: number;
	status: JobStatus;
	/** Exit status (bash convention: 128+n for signal n), or null when unknown. */
	exitCode?: number | null;
	signal?: string | null;
	timeoutSeconds: number;
	/** Set when the job was stopped by kill() or shutdown(). */
	killedBy?: "request" | "shutdown";
	until?: WatchUntil;
	/** Configured delay between watch checks; absent for plain commands. */
	intervalSeconds?: number;
	checks?: number;
	lastCheck?: CheckResult;
	/** The log hit its size cap; later output was discarded. */
	logTruncated?: boolean;
	/** First log write error (output after it was not logged). */
	logError?: string;
	/** Why the job could not run (e.g. spawn failure). */
	error?: string;
}

export interface StartOptions {
	command: string;
	cwd: string;
	timeoutSeconds: number;
	label?: string;
}

export interface WatchOptions {
	check: string;
	cwd: string;
	intervalSeconds: number;
	timeoutSeconds: number;
	checkTimeoutSeconds: number;
	until: WatchUntil;
	label?: string;
}

export interface ManagerOptions {
	logRoot: string;
	onTerminal: (job: JobSnapshot) => void;
	/**
	 * Cap on running jobs + watches. A finished job's or check's supervisor stays alive for up to
	 * `killGraceMs` while it cleans up its process group, and is not counted here. During that
	 * window the group can still hold user processes: leftovers that ignore SIGTERM keep running
	 * until the SIGKILL at the end of the grace period. The exclusion is deliberate: the window
	 * is bounded (one supervisor per finished job or check, at most `killGraceMs` each, then
	 * the whole group is SIGKILLed), and counting it would make every completion block a new
	 * job for the grace period.
	 */
	maxRunning?: number;
	/**
	 * Cap on running watches, counted separately from commands: a watch only runs a short check
	 * every `intervalSeconds`, so watches are cheap and must not crowd out real commands (or each other).
	 */
	maxRunningWatches?: number;
	/** Delay between SIGTERM and SIGKILL for a process group. */
	killGraceMs?: number;
	/** After a command's status is known, how long to wait for its output pipes to close. */
	drainMs?: number;
	/** Finished jobs kept for job_list / job_output. */
	keepFinished?: number;
	/** In-memory cap for one watch check's output. */
	checkOutputBytes?: number;
	/** Per-job log size cap. */
	logCapBytes?: number;
	env?: NodeJS.ProcessEnv;
	/**
	 * Called when the manager starts or stops owning live processes (running jobs or
	 * supervisors still cleaning up). The adapter uses it to register for the process 'exit'
	 * hook only while needed.
	 */
	onActiveChange?: (active: boolean) => void;
}

export interface ResolvedManagerOptions {
	logRoot: string;
	onTerminal: (job: JobSnapshot) => void;
	onActiveChange: (active: boolean) => void;
	maxRunning: number;
	maxRunningWatches: number;
	killGraceMs: number;
	drainMs: number;
	keepFinished: number;
	checkOutputBytes: number;
	logCapBytes: number;
	env: NodeJS.ProcessEnv;
}

export const DEFAULT_MAX_RUNNING = 8;
export const DEFAULT_MAX_RUNNING_WATCHES = 32;

/** A positive integer from the environment, or undefined. */
function envLimit(env: NodeJS.ProcessEnv, name: string): number | undefined {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}
export const DEFAULT_KILL_GRACE_MS = 5000;
export const DEFAULT_DRAIN_MS = 1000;

/**
 * Apply defaults per field with `??`, so an explicit `undefined` (an adapter forwarding an
 * unset option) never replaces a default.
 */
export function resolveManagerOptions(options: ManagerOptions): ResolvedManagerOptions {
	const env = options.env ?? process.env;
	return {
		logRoot: options.logRoot,
		onTerminal: options.onTerminal,
		onActiveChange: options.onActiveChange ?? (() => {}),
		maxRunning: options.maxRunning ?? envLimit(env, "PI_JOBS_MAX_RUNNING") ?? DEFAULT_MAX_RUNNING,
		maxRunningWatches: options.maxRunningWatches ?? envLimit(env, "PI_JOBS_MAX_WATCHES") ?? DEFAULT_MAX_RUNNING_WATCHES,
		killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
		drainMs: options.drainMs ?? DEFAULT_DRAIN_MS,
		keepFinished: options.keepFinished ?? 50,
		checkOutputBytes: options.checkOutputBytes ?? 64 * 1024,
		logCapBytes: options.logCapBytes ?? DEFAULT_LOG_CAP_BYTES,
		env,
	};
}

type Pending = "timeout" | "kill";

interface Job {
	snap: JobSnapshot;
	/** The command's run, or the currently running check of a watch. */
	run?: SupervisedRun;
	log?: LogWriter;
	pending?: Pending;
	notify: boolean;
	timers: Set<NodeJS.Timeout>;
	done: Promise<void>;
	resolveDone: () => void;
	baseline?: string;
}

/**
 * The terminal transition. Returns false (and changes nothing) unless the job is still
 * running, so racing exit/timeout/kill paths can never produce a second terminal state.
 */
export function settleSnapshot(snap: JobSnapshot, status: Exclude<JobStatus, "running">, now: number, extra: Partial<JobSnapshot> = {}): boolean {
	if (snap.status !== "running") return false;
	Object.assign(snap, extra);
	snap.status = status;
	snap.endedAt = now;
	return true;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

export class JobManager {
	readonly opts: ResolvedManagerOptions;
	private readonly tag = randomBytes(3).toString("hex");
	private readonly running = new Map<string, Job>();
	private finished: Job[] = [];
	/** Supervisors not yet reaped: the processes this manager owns. */
	private readonly runs = new Set<SupervisedRun>();
	private seq = 0;
	private closed = false;
	private active = false;

	constructor(options: ManagerOptions) {
		this.opts = resolveManagerOptions(options);
	}

	/** Never reuse an id already present in this session, including pruned history. */
	advanceSequence(highest: number): void {
		this.seq = Math.max(this.seq, highest);
	}

	get runningCount(): number {
		return this.running.size;
	}

	/** True while the manager owns running jobs or supervisors that are still cleaning up. */
	get ownsProcesses(): boolean {
		return this.running.size > 0 || this.runs.size > 0;
	}

	start(options: StartOptions): JobSnapshot {
		const job = this.create("command", options.command, options.cwd, options.timeoutSeconds, options.label);
		try {
			const log = (job.log = new LogWriter(job.snap.logPath, this.opts.logCapBytes));
			job.run = this.launch(options.command, options.cwd, chunk => log.write(chunk), outcome => this.commandDone(job, outcome));
		} catch (err) {
			// Synchronous failure (log not writable, invalid argument such as a NUL byte): the job
			// never existed.
			this.discard(job);
			throw err;
		}
		this.addTimer(job, options.timeoutSeconds * 1000, () => this.stop(job, "timeout"));
		return { ...job.snap };
	}

	watch(options: WatchOptions): JobSnapshot {
		const job = this.create("watch", options.check, options.cwd, options.timeoutSeconds, options.label);
		job.snap.until = options.until;
		job.snap.intervalSeconds = options.intervalSeconds;
		job.snap.checks = 0;
		try {
			job.log = new LogWriter(job.snap.logPath, this.opts.logCapBytes);
			job.log.write(`# pi-jobs watch until ${options.until}: ${options.check}\n`);
			this.runCheck(job, options);
		} catch (err) {
			this.discard(job);
			throw err;
		}
		this.addTimer(job, options.timeoutSeconds * 1000, () => this.stop(job, "timeout"));
		return { ...job.snap };
	}

	/** Stop a running job. No notification is sent; the returned snapshot is its final state. */
	async kill(id: string): Promise<JobSnapshot> {
		const job = this.running.get(id);
		if (!job) {
			const done = this.finished.find(j => j.snap.id === id);
			if (done) return { ...done.snap };
			throw new Error(`No job with id ${id} in this session.`);
		}
		job.notify = false;
		job.snap.killedBy = "request";
		this.stop(job, "kill");
		await this.waitFor([job], this.opts.killGraceMs + this.opts.drainMs + 1000);
		return { ...job.snap };
	}

	/**
	 * Stop everything, silently: SIGTERM, up to `waitMs` for jobs to end, then SIGKILL every
	 * owned group, destroy every pipe and clear every timer. Safe to call more than once.
	 */
	async shutdown(waitMs = 1500): Promise<void> {
		this.closed = true;
		const jobs = [...this.running.values()];
		for (const job of jobs) {
			job.notify = false;
			job.snap.killedBy = "shutdown";
			this.stop(job, "kill");
		}
		await this.waitFor(jobs, Math.min(waitMs, this.opts.killGraceMs));
		this.killAllSync();
		for (const job of jobs) job.run?.dispose();
		for (const job of [...this.running.values()]) this.settle(job, "killed");
		for (const run of this.runs) run.dispose();
	}

	/** SIGKILL every group this manager still owns. Synchronous: usable from process 'exit'. */
	killAllSync(): void {
		this.closed = true;
		for (const job of this.running.values()) job.notify = false;
		for (const run of this.runs) run.killNow();
	}

	get(id: string): JobSnapshot | undefined {
		const job = this.running.get(id) ?? this.finished.find(j => j.snap.id === id);
		return job && { ...job.snap };
	}

	/** Running jobs first (oldest first), then finished jobs (newest first). */
	list(): JobSnapshot[] {
		return [...this.running.values(), ...this.finished].map(j => ({ ...j.snap }));
	}

	output(id: string, maxLines: number, maxBytes: number): Tail {
		const job = this.get(id);
		if (!job) throw new Error(`No job with id ${id} in this session.`);
		return readTail(job.logPath, maxLines, maxBytes);
	}

	/** Tail used in the completion notification. */
	notificationTail(job: JobSnapshot, maxLines: number, maxBytes: number): Tail {
		if (job.kind === "watch") return tailBuffer(Buffer.from(job.lastCheck?.output ?? "", "utf8"), maxLines, maxBytes);
		return readTail(job.logPath, maxLines, maxBytes);
	}

	private launch(command: string, cwd: string, onOutput: (chunk: Buffer, stream: "out" | "err") => void, onDone: (o: RunOutcome) => void): SupervisedRun {
		const run: SupervisedRun = new SupervisedRun({
			command,
			cwd,
			env: this.opts.env,
			graceMs: this.opts.killGraceMs,
			drainMs: this.opts.drainMs,
			onOutput,
			onDone,
			onReaped: () => {
				this.runs.delete(run);
				this.updateActive();
			},
		});
		this.runs.add(run);
		this.updateActive();
		return run;
	}

	private commandDone(job: Job, outcome: RunOutcome): void {
		if (outcome.error) job.log?.write(`pi-jobs: failed to start: ${outcome.error}\n`);
		const status: Exclude<JobStatus, "running"> =
			job.pending === "timeout" ? "timed_out" : job.pending === "kill" ? "killed" : outcome.exitCode === 0 ? "succeeded" : "failed";
		this.settle(job, status, { exitCode: outcome.exitCode, signal: outcome.signal, ...(outcome.error ? { error: outcome.error } : {}) });
	}

	private create(kind: JobKind, command: string, cwd: string, timeoutSeconds: number, label?: string): Job {
		if (this.closed) throw new Error("The session is shutting down; no new background jobs.");
		const sameKind = [...this.running.values()].filter(j => j.snap.kind === kind).length;
		const cap = kind === "watch" ? this.opts.maxRunningWatches : this.opts.maxRunning;
		if (sameKind >= cap)
			throw new Error(
				`Too many running background ${kind === "watch" ? "watches" : "jobs"} (${sameKind}/${cap}). ` +
					"Wait for a completion notification or stop one with job_kill.",
			);
		let isDir = false;
		try {
			isDir = statSync(cwd).isDirectory();
		} catch {}
		if (!isDir) throw new Error(`cwd is not an existing directory: ${cwd}`);

		const id = `j${++this.seq}`;
		const now = new Date();
		const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
		const dir = join(this.opts.logRoot, day);
		mkdirSync(dir, { recursive: true });
		let resolveDone!: () => void;
		const done = new Promise<void>(r => (resolveDone = r));
		const job: Job = {
			snap: {
				id,
				kind,
				label: label?.trim() || undefined,
				command,
				cwd,
				logPath: join(dir, `${time}-${this.tag}-${id}.log`),
				startedAt: now.getTime(),
				status: "running",
				timeoutSeconds,
			},
			notify: true,
			timers: new Set(),
			done,
			resolveDone,
		};
		this.running.set(id, job);
		this.updateActive();
		return job;
	}

	/** Undo create() for a job that never started. */
	private discard(job: Job): void {
		for (const timer of job.timers) clearTimeout(timer);
		job.timers.clear();
		job.log?.close();
		this.running.delete(job.snap.id);
		job.resolveDone();
		this.updateActive();
	}

	private runCheck(job: Job, options: WatchOptions): void {
		if (job.snap.status !== "running") return;
		const n = (job.snap.checks = (job.snap.checks ?? 0) + 1);
		const sink = new TailSink(this.opts.checkOutputBytes);
		// Full-stream digests for until:"change" (the sink keeps only a bounded tail). One per
		// stream, so nondeterministic stdout/stderr interleaving cannot look like a change.
		const outHash = createHash("sha256");
		const errHash = createHash("sha256");
		let timedOut = false;
		let checkTimer: NodeJS.Timeout | undefined;
		let run: SupervisedRun | undefined;
		const finish = (outcome: RunOutcome): void => {
			if (checkTimer) {
				clearTimeout(checkTimer);
				job.timers.delete(checkTimer);
			}
			if (job.run === run) job.run = undefined;
			if (outcome.error) sink.push(Buffer.from(`pi-jobs: failed to run check: ${outcome.error}\n`));
			const raw = sink.toBuffer();
			const output = tailBuffer(raw, 1000, this.opts.checkOutputBytes, !sink.dropped).text;
			const outputHash = `${outHash.digest("hex")}:${errHash.digest("hex")}`;
			// A check stopped by the watch's own timeout or kill is inconclusive too.
			const result: CheckResult = { exitCode: outcome.exitCode, signal: outcome.signal, timedOut: timedOut || job.pending !== undefined, output, outputHash };
			const status = result.timedOut ? "timed out" : outcome.signal ? `signal ${outcome.signal}` : `exit ${outcome.exitCode}`;
			job.log?.write(`--- check ${n} · ${new Date().toISOString()} · ${status} ---\n`);
			job.log?.write(raw);
			if (raw.length && raw[raw.length - 1] !== 10) job.log?.write("\n");
			if (job.snap.status !== "running") return;
			// A check cut short by the watch's own timeout/kill says less than the last completed
			// one: keep reporting that.
			if (job.pending === undefined || !job.snap.lastCheck) job.snap.lastCheck = result;
			if (job.pending === "kill") return void this.settle(job, "killed");
			if (job.pending === "timeout") return void this.settle(job, "timed_out");
			const verdict = evaluateWatch(options.until, result, job.baseline);
			job.baseline = verdict.baseline;
			if (verdict.matched) return void this.settle(job, "matched", { exitCode: outcome.exitCode, signal: outcome.signal });
			this.addTimer(job, options.intervalSeconds * 1000, () => this.runCheck(job, options));
		};
		try {
			run = this.launch(
				options.check,
				options.cwd,
				(chunk, stream) => {
					(stream === "err" ? errHash : outHash).update(chunk);
					sink.push(chunk);
				},
				finish,
			);
		} catch (err) {
			// The first check failing synchronously means the check can never run: let watch() reject.
			if (n === 1) throw err;
			return finish({ exitCode: null, signal: null, error: (err as Error).message });
		}
		job.run = run;
		checkTimer = this.addTimer(job, options.checkTimeoutSeconds * 1000, () => {
			timedOut = true;
			run!.terminate();
		});
	}

	/** Begin stopping a job; it settles when its run reports. */
	private stop(job: Job, reason: Pending): void {
		if (job.snap.status !== "running") return;
		job.pending ??= reason;
		if (job.run) job.run.terminate();
		else if (job.snap.kind === "watch") this.settle(job, job.pending === "timeout" ? "timed_out" : "killed");
	}

	private settle(job: Job, status: Exclude<JobStatus, "running">, extra: Partial<JobSnapshot> = {}): void {
		if (job.snap.status !== "running") return;
		const log = job.log;
		const logExtra: Partial<JobSnapshot> = {};
		if (log?.truncated) logExtra.logTruncated = true;
		if (log?.error) logExtra.logError = log.error;
		if (!settleSnapshot(job.snap, status, Date.now(), { ...extra, ...logExtra })) return;
		log?.close();
		for (const timer of job.timers) clearTimeout(timer);
		job.timers.clear();
		this.running.delete(job.snap.id);
		this.finished.unshift(job);
		this.finished.length = Math.min(this.finished.length, this.opts.keepFinished);
		job.resolveDone();
		this.updateActive();
		if (!job.notify) return;
		try {
			this.opts.onTerminal({ ...job.snap });
		} catch {
			// A failing notifier must not break job bookkeeping.
		}
	}

	private updateActive(): void {
		const now = this.ownsProcesses;
		if (now === this.active) return;
		this.active = now;
		try {
			this.opts.onActiveChange(now);
		} catch {}
	}

	private addTimer(job: Job, ms: number, fn: () => void): NodeJS.Timeout | undefined {
		if (job.snap.status !== "running") return undefined;
		const timer = setTimeout(() => {
			job.timers.delete(timer);
			fn();
		}, ms);
		timer.unref();
		job.timers.add(timer);
		return timer;
	}

	private async waitFor(jobs: Job[], ms: number): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			Promise.all(jobs.map(j => j.done)),
			new Promise<void>(r => {
				timer = setTimeout(r, ms);
			}),
		]);
		clearTimeout(timer);
	}
}
