/**
 * Supervised process groups.
 *
 * Why a supervisor: a process group id (PGID) is the pid of the process that created the
 * group. Once that leader has been reaped and every member is gone, the kernel may hand the
 * same number to a new process, which can create a new group with it. A delayed
 * `kill(-pgid, SIGKILL)` aimed at "our" group can then hit an unrelated one. The old design
 * ran the command itself as group leader, so after a normal exit (reaped by Node) its
 * leftover processes were signalled later through a PGID nothing guaranteed was still ours.
 *
 * Invariant used here: **Node only signals a group whose leader it has not reaped.** An
 * unreaped leader (alive or zombie) still owns its pid, so its PGID cannot be reused, and
 * `child.exitCode === null && child.signalCode === null` tells us exactly that: libuv reaps
 * the child and runs Node's exit callback (which sets those fields) in the same callback, with
 * no other JavaScript in between.
 *
 * To keep that invariant useful, the group leader is a tiny bash supervisor that outlives the
 * command: it runs the command as a child in its own group, reports the command's exit
 * status on fd 3 the moment it is known, then cleans up leftovers itself (SIGTERM to the group
 * while it survives through a no-op trap, wait the grace period, SIGKILL to the group, which
 * ends the supervisor too). The group can therefore never outlive its leader, and every group
 * signal — from Node or from the supervisor — is sent while the leader still holds the PGID.
 * Processes that leave the group (setsid, double-fork into a new session) are out of reach
 * by design; see `drainMs` for how they are prevented from stalling a job.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * $1 = grace seconds, $2 = command. The command gets the default SIGTERM disposition (trap
 * handlers, unlike ignored signals, are reset on exec) and no fd 3. The supervisor drops its
 * own copies of stdout/stderr so it never holds the output pipes open.
 */
export const SUPERVISOR_SCRIPT = `trap ':' TERM
bash -c "$2" 3>&- &
child=$!
exec 0</dev/null 1>/dev/null 2>/dev/null
while :; do
  wait "$child"; st=$?
  kill -0 "$child" 2>/dev/null || break
done
printf '%s\\n' "$st" >&3
exec 3>&-
kill -s TERM -- -$$ 2>/dev/null
sleep "$1"
kill -s KILL -- -$$`;

export interface RunOutcome {
	/**
	 * Exit status reported by bash for the command, or null if the supervisor died first.
	 * bash reports death by signal n as 128+n, which a command can also exit with on purpose,
	 * so a status above 128 is only an inference (see format.ts `exitText`).
	 */
	exitCode: number | null;
	/** Verified signal: only set when the supervisor itself was killed (no status reported). */
	signal: string | null;
	/** Set when the run could not be started. */
	error?: string;
}

export function outcomeFromStatus(status: number): RunOutcome {
	return { exitCode: status, signal: null };
}

export interface RunOptions {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** SIGTERM → SIGKILL delay, used by the supervisor for leftovers and by terminate(). */
	graceMs: number;
	/**
	 * After the command's status is known (or the supervisor died), how long to wait for the
	 * output pipes to reach EOF before destroying them. Bounds jobs whose escaped descendants
	 * keep stdout open.
	 */
	drainMs: number;
	onOutput: (chunk: Buffer, stream: "out" | "err") => void;
	/** Exactly once, when the command has finished and output is drained (or abandoned). */
	onDone: (outcome: RunOutcome) => void;
	/** When the supervisor has been reaped: the run no longer owns any process. */
	onReaped: () => void;
}

export class SupervisedRun {
	readonly pid: number | undefined;
	private readonly child: ChildProcess;
	private readonly opts: RunOptions;
	private status: number | undefined;
	private statusText = "";
	private reaped = false;
	private exitSignal: string | null = null;
	private spawnError: string | undefined;
	private open = new Set<Readable>();
	private drainTimer: NodeJS.Timeout | undefined;
	private escalateTimer: NodeJS.Timeout | undefined;
	private done = false;

	/** Throws synchronously on invalid arguments (e.g. a NUL byte in the command). */
	constructor(opts: RunOptions) {
		this.opts = opts;
		const graceSeconds = (Math.max(0, opts.graceMs) / 1000).toFixed(3);
		this.child = spawn("bash", ["-c", SUPERVISOR_SCRIPT, "pi-jobs-supervisor", graceSeconds, opts.command], {
			cwd: opts.cwd,
			env: opts.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
		});
		this.pid = this.child.pid;
		const [, out, err, status] = this.child.stdio as [unknown, Readable, Readable, Readable];
		for (const stream of [out, err, status]) {
			this.open.add(stream);
			stream.on("close", () => {
				this.open.delete(stream);
				this.maybeFinish();
			});
			stream.on("error", () => {});
			(stream as unknown as { unref?: () => void }).unref?.();
		}
		out.on("data", (c: Buffer) => this.output(c, "out"));
		err.on("data", (c: Buffer) => this.output(c, "err"));
		status.on("data", (c: Buffer) => {
			this.statusText += c.toString("utf8");
			const line = /^(\d+)\n/.exec(this.statusText);
			if (line && this.status === undefined) {
				this.status = Number(line[1]);
				this.startDrain();
			}
		});
		this.child.on("exit", (_code, signal) => {
			this.reaped = true;
			this.exitSignal = signal;
			if (this.escalateTimer) clearTimeout(this.escalateTimer);
			this.escalateTimer = undefined;
			this.startDrain();
			this.opts.onReaped();
		});
		this.child.on("error", err => {
			// Spawn failure (e.g. bash missing): there is no process and never will be.
			this.spawnError = err.message;
			if (!this.reaped && this.child.pid === undefined) {
				this.reaped = true;
				this.opts.onReaped();
			}
			this.finish();
		});
		this.child.unref();
	}

	/** True while the supervisor is unreaped, i.e. while signalling its group is safe. */
	get leaderAlive(): boolean {
		return !this.reaped && this.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null;
	}

	/** Signal the whole group — only while the leader is unreaped (see module comment). */
	signalGroup(signal: NodeJS.Signals): boolean {
		if (!this.leaderAlive) return false;
		try {
			process.kill(-this.pid!, signal);
			return true;
		} catch {
			return false;
		}
	}

	/** SIGTERM the group now, SIGKILL it after the grace period if the leader still lives. */
	terminate(): void {
		if (!this.signalGroup("SIGTERM")) return;
		if (this.escalateTimer) return;
		this.escalateTimer = setTimeout(() => {
			this.escalateTimer = undefined;
			this.signalGroup("SIGKILL");
		}, this.opts.graceMs);
		this.escalateTimer.unref();
	}

	/** Synchronous SIGKILL of the group (shutdown / process exit). */
	killNow(): void {
		this.signalGroup("SIGKILL");
	}

	/** Stop waiting for output: destroy the pipes and clear every timer. Idempotent. */
	dispose(): void {
		if (this.drainTimer) clearTimeout(this.drainTimer);
		if (this.escalateTimer) clearTimeout(this.escalateTimer);
		this.drainTimer = this.escalateTimer = undefined;
		for (const stream of this.open) stream.destroy();
		this.open.clear();
	}

	private output(chunk: Buffer, stream: "out" | "err"): void {
		if (this.done) return;
		try {
			this.opts.onOutput(chunk, stream);
		} catch {}
	}

	private startDrain(): void {
		if (this.done || this.drainTimer) return;
		if (this.maybeFinish()) return;
		this.drainTimer = setTimeout(() => this.finish(), this.opts.drainMs);
		this.drainTimer.unref();
	}

	/** Finish once the status is known (or the leader is gone) and every pipe is closed. */
	private maybeFinish(): boolean {
		if (this.done) return true;
		if (this.status === undefined && !this.reaped) return false;
		if (this.open.size > 0) return false;
		this.finish();
		return true;
	}

	private finish(): void {
		if (this.done) return;
		this.done = true;
		if (this.drainTimer) clearTimeout(this.drainTimer);
		this.drainTimer = undefined;
		for (const stream of this.open) stream.destroy();
		this.open.clear();
		let outcome: RunOutcome;
		if (this.spawnError !== undefined) outcome = { exitCode: null, signal: null, error: this.spawnError };
		else if (this.status !== undefined) outcome = outcomeFromStatus(this.status);
		else outcome = { exitCode: null, signal: this.exitSignal ?? "SIGKILL" };
		try {
			this.opts.onDone(outcome);
		} catch {}
	}
}
