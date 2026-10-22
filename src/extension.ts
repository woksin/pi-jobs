/**
 * pi-jobs — background shell jobs and watches that wake the agent when they finish.
 *
 * Thin pi adapter over JobManager and Delivery: tool schemas, completion messages (see
 * delivery.ts for the delivery paths and the guarantee), the /jobs command and lifecycle
 * cleanup. Only type imports from pi, so tests can load it under plain `node` with a fake
 * ExtensionAPI.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { CUSTOM_TYPE, dedupeCompletions, Delivery, type DeliveryHost, type Completion } from "./delivery.ts";
import { formatBatch, formatJobList, formatJobLine, jobTitle } from "./format.ts";
import { JobManager, type JobSnapshot } from "./jobs.ts";
import { defaultLogRoot, pruneLogs } from "./logs.ts";
import { expireReloadOwner, highestJobId, historicalRunningJobs, sessionOwners, stopOrphans, takeReloadOwner, type Owner } from "./ownership.ts";
import type { WatchUntil } from "./watch.ts";

export { CUSTOM_TYPE };
export const MAX_TIMEOUT_SECONDS = 4 * 3600;
export const MIN_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 3600;
export const DEFAULT_CHECK_TIMEOUT_SECONDS = 120;
export const NOTIFY_LINES = 40;
export const NOTIFY_BYTES = 4096;
/** Total output budget of one wake-up message, shared by all completions in it. */
export const BATCH_BYTES = 16 * 1024;
export const OUTPUT_DEFAULT_LINES = 40;
export const OUTPUT_MAX_LINES = 200;
export const OUTPUT_BYTES = 16 * 1024;

export interface JobsExtensionOptions {
	logRoot?: string;
	maxRunning?: number;
	maxRunningWatches?: number;
	killGraceMs?: number;
	drainMs?: number;
	logCapBytes?: number;
	/** Test seam: receives the session's JobManager. */
	onManager?: (manager: JobManager) => void;
	/** Lower bound for job_watch intervalSeconds (tests use a smaller one). */
	minIntervalSeconds?: number;
}

const WAKE_NOTE = "Returns immediately. End your turn after starting: you are woken automatically when it finishes. Do not poll with job_list/job_output, sleep or bash loops.";
const CI_NOTE =
	"For CI, watch an immutable target: `gh run watch <run-id> --exit-status`, or the checks of a specific commit SHA — not a PR number, which can move to a newer commit while you wait.";

const timeoutSchema = (description: string) => ({ type: "number", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description });

export const startParams = {
	type: "object",
	properties: {
		command: { type: "string", minLength: 1, description: "Shell command, run with `bash -c` in its own process group; stdout+stderr go to a log file. stdin is closed." },
		timeoutSeconds: timeoutSchema(`Hard limit in seconds (1–${MAX_TIMEOUT_SECONDS}); the whole process group is killed after it.`),
		cwd: { type: "string", description: "Working directory (default: session cwd)." },
		label: { type: "string", description: "Short name shown in the notification." },
	},
	required: ["command", "timeoutSeconds"],
	additionalProperties: false,
};

export function watchParams(minInterval = MIN_INTERVAL_SECONDS) {
	return {
		type: "object",
		properties: {
			check: { type: "string", minLength: 1, description: "Check command (bash -c), run repeatedly." },
			intervalSeconds: { type: "number", minimum: minInterval, maximum: MAX_INTERVAL_SECONDS, description: `Delay between checks in seconds (${minInterval}–${MAX_INTERVAL_SECONDS}).` },
			timeoutSeconds: timeoutSchema(`Give up after this many seconds (1–${MAX_TIMEOUT_SECONDS}).`),
			until: {
				type: "string",
				enum: ["success", "failure", "change"],
				description: "success (default): check exits 0. failure: check exits non-zero. change: exit code or output differs from the first check.",
			},
			checkTimeoutSeconds: timeoutSchema(
				`Per-check limit in seconds; a check that exceeds it is killed and counts as inconclusive. Default: min(${DEFAULT_CHECK_TIMEOUT_SECONDS}, timeoutSeconds).`,
			),
			cwd: { type: "string", description: "Working directory (default: session cwd)." },
			label: { type: "string", description: "Short name shown in the notification." },
		},
		required: ["check", "intervalSeconds", "timeoutSeconds"],
		additionalProperties: false,
	};
}

const idParams = {
	type: "object",
	properties: { id: { type: "string", minLength: 1, description: "Job id, e.g. j3." } },
	required: ["id"],
	additionalProperties: false,
};

export const outputParams = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1, description: "Job id, e.g. j3." },
		tailLines: { type: "integer", minimum: 1, maximum: OUTPUT_MAX_LINES, description: `Lines from the end (default ${OUTPUT_DEFAULT_LINES}; at most ${OUTPUT_BYTES / 1024} KB).` },
	},
	required: ["id"],
	additionalProperties: false,
};

function seconds(value: unknown, name: string, min: number, max: number, unit = "seconds"): number {
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`${name} must be a number (${unit}).`);
	if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max} ${unit} (got ${n}).`);
	return n;
}

function text(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string.`);
	return value;
}

function resolveCwd(value: unknown, base: string): string {
	if (value === undefined || value === null || value === "") return base;
	const cwd = text(value, "cwd");
	return isAbsolute(cwd) ? cwd : resolve(base, cwd);
}

function result(textOut: string, details: unknown) {
	return { content: [{ type: "text" as const, text: textOut }], details };
}

interface SessionContext {
	sessionManager?: { getSessionId(): string; getEntries(): readonly any[] };
	isIdle?: () => boolean;
	signal?: AbortSignal;
	ui?: { notify?: (message: string, level: string) => void };
}

/** Snapshot for message/tool details, without bulky check output. */
function brief(job: JobSnapshot): JobSnapshot {
	const { lastCheck, ...rest } = job;
	return lastCheck ? { ...rest, lastCheck: { ...lastCheck, output: "" } } : rest;
}

/** Per-completion output budget so that a batch's tails together stay within BATCH_BYTES. */
export function tailBudget(count: number): number {
	return Math.min(NOTIFY_BYTES, Math.floor(BATCH_BYTES / Math.max(1, count)));
}

export const LIVE_MANAGERS_KEY = Symbol.for("pi-jobs.liveManagers");

/**
 * One process-wide 'exit' hook for all extension instances (main session and subagents), so
 * many sessions do not pile up listeners. Keyed on a global symbol because each instance may
 * load its own copy of this module. A manager is in the set only while it owns processes, so
 * sessions disposed without session_shutdown do not leak.
 */
export function liveManagers(): Set<JobManager> {
	const key = LIVE_MANAGERS_KEY;
	const g = globalThis as unknown as Record<symbol, Set<JobManager> | undefined>;
	let set = g[key];
	if (!set) {
		const managers = new Set<JobManager>();
		set = g[key] = managers;
		process.on("exit", () => {
			for (const m of managers) m.killAllSync();
		});
	}
	return set;
}

export function createJobsExtension(options: JobsExtensionOptions = {}) {
	return function jobsExtension(pi: ExtensionAPI): void {
		const logRoot = options.logRoot ?? defaultLogRoot();
		const minInterval = options.minIntervalSeconds ?? MIN_INTERVAL_SECONDS;

		const live = liveManagers();
		// Latest context seen (pi's contexts read live state; a stale one throws).
		let ctxRef: SessionContext | undefined;
		const remember = (ctx: unknown) => {
			if (ctx && typeof ctx === "object") ctxRef = ctx as SessionContext;
		};

		const host: DeliveryHost<JobSnapshot> = {
			isIdle: () => (typeof ctxRef?.isIdle === "function" ? ctxRef.isIdle() : true),
			aborted: () => ctxRef?.signal?.aborted === true,
			send: (deliveryId, completions) => {
				const budget = tailBudget(completions.length);
				const items = completions.map(c => ({ job: c.payload, tail: manager.notificationTail(c.payload, NOTIFY_LINES, budget) }));
				const { parts, partOf } = formatBatch(items);
				pi.sendMessage(
					{
						customType: CUSTOM_TYPE,
						content: parts.map(text => ({ type: "text" as const, text })),
						display: true,
						// `part`: the content part holding this completion (used by dedupeCompletions).
						details: { deliveryId, completions: completions.map((c, i) => ({ completionId: c.completionId, part: partOf[i], job: brief(c.payload) })) },
					},
					// pi decides: streaming → its follow-up queue; otherwise → start a run.
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			},
			lost: items => {
				try {
					ctxRef?.ui?.notify?.(`pi-jobs: session context is gone; completion of ${items.map(i => i.payload.id).join(", ")} was not delivered (see /jobs).`, "warning");
				} catch {}
			},
		};
		let delivery = new Delivery<JobSnapshot>(host);

		let manager: JobManager = new JobManager({
			logRoot,
			maxRunning: options.maxRunning,
			maxRunningWatches: options.maxRunningWatches,
			killGraceMs: options.killGraceMs,
			drainMs: options.drainMs,
			logCapBytes: options.logCapBytes,
			// Last line of defence against orphans if pi exits without session_shutdown.
			onActiveChange: active => {
				if (active) live.add(manager);
				else live.delete(manager);
			},
			onTerminal: job => delivery.add({ completionId: randomUUID(), payload: job } satisfies Completion<JobSnapshot>),
		});
		options.onManager?.(manager);
		const token = {};
		let owner: Owner | undefined;
		let sessionId: string | undefined;
		let retired = false;

		const reportReloadLoss = (jobs: JobSnapshot[]) => {
			for (const job of jobs) {
				const message = `pi-jobs: ${job.kind} ${job.id}${job.label ? ` (${job.label})` : ""} was not adopted. Last recorded as running; it may have finished or been stopped by the old version. Check before re-arming.\n` +
					`command: ${job.command}\ncwd: ${job.cwd}\nlog: ${job.logPath}\n` +
					`timeoutSeconds: ${job.timeoutSeconds}${job.kind === "watch" ? `; until: ${job.until}; intervalSeconds: ${job.intervalSeconds ?? "not recorded by old version"}` : ""}`;
				ctxRef?.ui?.notify?.(message, "warning");
				// UI notifications alone are not model context. Persist the full command without
				// starting a turn while other session_start handlers are still initializing.
				pi.sendMessage({ customType: "pi-jobs-reload", content: message, display: true, details: { unadopted: job } }, { triggerTurn: false });
			}
		};

		pi.on("agent_start", async (_e: unknown, ctx: unknown) => {
			remember(ctx);
			delivery.onAgentStart();
		});
		pi.on("agent_end", async (_e: unknown, ctx: unknown) => {
			remember(ctx);
			delivery.onAgentEnd();
		});
		pi.on("agent_settled", async (_e: unknown, ctx: unknown) => {
			remember(ctx);
			delivery.onAgentSettled();
		});
		pi.on("message_end", async (e: { message?: { role?: string; customType?: string; details?: { deliveryId?: unknown } } }) => {
			const m = e?.message;
			if (m?.role === "custom" && m.customType === CUSTOM_TYPE && typeof m.details?.deliveryId === "string") delivery.confirm(m.details.deliveryId);
		});
		// End of non-agent busy work. session_compact and session_tree fire before pi clears its
		// busy state; session_compact_failed fires after it.
		pi.on("session_compact", async () => delivery.onBusyEnd(false));
		pi.on("session_compact_failed", async () => delivery.onBusyEnd(true));
		pi.on("session_tree", async () => delivery.onBusyEnd(false));
		// The model sees each completion id at most once (a stranded follow-up may reappear).
		// Per completion for indexed messages; legacy unindexed messages are stubbed only as a whole.
		pi.on("context", async (e: { messages: any[] }) => {
			const messages = dedupeCompletions(e.messages);
			return messages ? { messages } : undefined;
		});

		pi.on("session_start", async (event, ctx) => {
			remember(ctx);
			sessionId = ctx.sessionManager?.getSessionId();
			const owners = sessionOwners();
			if (sessionId) {
				const handoff = event.reason === "reload" ? await takeReloadOwner(sessionId) : {};
				const previous = handoff.owner;
				if (previous) {
					manager = previous.manager;
					delivery.dispose();
					delivery = previous.delivery;
					options.onManager?.(manager);
					ctxRef?.ui?.notify?.(`pi-jobs: re-adopted session ${sessionId}; job ids, watch loops and deadlines preserved (${manager.list().filter(j => j.status === "running").map(j => j.id).join(", ") || "no running jobs"}).`, "info");
				} else if (handoff.incompatible) {
					ctxRef?.ui?.notify?.("pi-jobs: incompatible reload handoff; stopped the old jobs/watches instead of adopting them. Inspect their recorded log paths.", "warning");
					reportReloadLoss(handoff.dropped?.length ? handoff.dropped : historicalRunningJobs(ctx.sessionManager.getEntries()));
				} else if (event.reason === "reload" && !owners.has(sessionId) && highestJobId(ctx.sessionManager.getEntries()) > 0) {
					ctxRef?.ui?.notify?.("pi-jobs: no reload handoff exists for this session. Earlier jobs/watches cannot be re-adopted (the old version may have stopped them); inspect their recorded log paths. Id numbering will continue from session history.", "warning");
					reportReloadLoss(historicalRunningJobs(ctx.sessionManager.getEntries()));
				}
				owner = { version: 2, manager, delivery, token, alive: () => {
					try { return typeof ctx.isIdle === "function" ? (ctx.isIdle(), true) : undefined; }
					catch (error) { return /stale.*(?:session|runtime)/i.test(String(error)) ? false : undefined; }
				} };
				owners.set(sessionId, owner);
				manager.advanceSequence(highestJobId(ctx.sessionManager.getEntries()));
			}
			for (const notice of await stopOrphans(owners)) ctxRef?.ui?.notify?.(notice, "warning");
			for (const [id, pending] of owners) {
				if (!pending.token) ctxRef?.ui?.notify?.(`pi-jobs: session ${id} is awaiting reload handoff; ownership is unknown, so its jobs/watches were not stopped.`, "warning");
			}
			try {
				pruneLogs(logRoot);
			} catch {}
			delivery.rebind(host);
		});

		pi.on("session_shutdown", async event => {
			if (retired) return;
			if (event.reason === "reload" && owner && sessionId) {
				// Timers belong to Node, not the extension runtime. Keep their one manager
				// (including watch options/baseline/deadline), pipes and supervisors alive.
				delivery.suspend();
				owner.token = undefined;
				expireReloadOwner(sessionId, owner);
				retired = true;
				return;
			}
			if (sessionId && sessionOwners().get(sessionId)?.token === token) sessionOwners().delete(sessionId);
			delivery.dispose();
			try {
				await manager.shutdown();
			} finally {
				// Only now leave the exit-hook set; SIGKILL anything still alive first.
				manager.killAllSync();
				live.delete(manager);
			}
		});

		pi.registerTool({
			name: "job_start",
			label: "Start background job",
			description: `Run a long shell command in the background (builds, test suites, CI watches). ${WAKE_NOTE} ${CI_NOTE}`,
			promptSnippet: "Run long commands in the background; you are woken when they finish",
			promptGuidelines: [
				"For waits longer than a minute (CI, long builds, polling a condition) use job_start or job_watch, then end your turn; the completion notification wakes you. Never poll them.",
				"For CI, watch an immutable target (`gh run watch <run-id> --exit-status`, or checks for a specific commit SHA), not a PR number.",
			],
			parameters: startParams as any,
			async execute(_id: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
				remember(ctx);
				const job = manager.start({
					command: text(params.command, "command"),
					timeoutSeconds: seconds(params.timeoutSeconds, "timeoutSeconds", 1, MAX_TIMEOUT_SECONDS),
					cwd: resolveCwd(params.cwd, ctx.cwd),
					label: typeof params.label === "string" ? params.label : undefined,
				});
				return result(
					`Started job ${job.id} (${jobTitle(job)}), timeout ${job.timeoutSeconds}s.\nlog: ${job.logPath}\n` +
						"End your turn now; you will be woken when it finishes.",
					brief(job),
				);
			},
		} as any);

		pi.registerTool({
			name: "job_watch",
			label: "Watch condition in background",
			description:
				"Re-run a check command in the background every intervalSeconds until a condition holds or timeoutSeconds passes, with no model involvement. " +
				"Use when no blocking watcher exists (prefer job_start with e.g. `gh run watch <run-id> --exit-status` when one does). " +
				`You are woken with the result and the last check's output. ${WAKE_NOTE}`,
			parameters: watchParams(minInterval) as any,
			async execute(_id: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
				remember(ctx);
				const timeoutSeconds = seconds(params.timeoutSeconds, "timeoutSeconds", 1, MAX_TIMEOUT_SECONDS);
				const until: WatchUntil = params.until ?? "success";
				if (!["success", "failure", "change"].includes(until)) throw new Error("until must be success, failure or change.");
				const job = manager.watch({
					check: text(params.check, "check"),
					intervalSeconds: seconds(params.intervalSeconds, "intervalSeconds", minInterval, MAX_INTERVAL_SECONDS),
					timeoutSeconds,
					checkTimeoutSeconds:
						params.checkTimeoutSeconds == null
							? Math.min(DEFAULT_CHECK_TIMEOUT_SECONDS, timeoutSeconds)
							: seconds(params.checkTimeoutSeconds, "checkTimeoutSeconds", 1, MAX_TIMEOUT_SECONDS),
					until,
					cwd: resolveCwd(params.cwd, ctx.cwd),
					label: typeof params.label === "string" ? params.label : undefined,
				});
				return result(
					`Started watch ${job.id} (${jobTitle(job)}) until ${until}, every ${params.intervalSeconds}s, timeout ${timeoutSeconds}s.\n` +
						`log: ${job.logPath}\nEnd your turn now; you will be woken when it finishes.`,
					brief(job),
				);
			},
		} as any);

		pi.registerTool({
			name: "job_list",
			label: "List background jobs",
			description: "List this session's background jobs and watches, running and recent. Not for waiting: completion wakes you automatically.",
			parameters: { type: "object", properties: {}, additionalProperties: false } as any,
			async execute() {
				const jobs = manager.list();
				return result(formatJobList(jobs), { jobs: jobs.map(brief) });
			},
		} as any);

		pi.registerTool({
			name: "job_output",
			label: "Background job output",
			description: `Bounded tail of a background job's log (at most ${OUTPUT_MAX_LINES} lines / ${OUTPUT_BYTES / 1024} KB). Use after a completion notification when you need more output; do not use it to poll a running job.`,
			parameters: outputParams as any,
			async execute(_id: string, params: any) {
				const id = text(params.id, "id");
				const lines = params.tailLines == null ? OUTPUT_DEFAULT_LINES : Math.floor(seconds(params.tailLines, "tailLines", 1, OUTPUT_MAX_LINES, "lines"));
				const job = manager.get(id);
				const tail = manager.output(id, lines, OUTPUT_BYTES);
				const head = `${formatJobLine(job!)}\nlog: ${job!.logPath}`;
				const body = tail.text === "" ? "(no output yet)" : `${tail.truncated ? "output (tail):" : "output:"}\n${tail.text}`;
				return result(`${head}\n${body}`, brief(job!));
			},
		} as any);

		pi.registerTool({
			name: "job_kill",
			label: "Stop background job",
			description: "Stop a running background job or watch: SIGTERM to its whole process group, SIGKILL after a grace period. Returns the final state; no completion notification follows.",
			parameters: idParams as any,
			async execute(_id: string, params: any) {
				const before = manager.get(text(params.id, "id"));
				const job = await manager.kill(params.id);
				const prefix = before && before.status !== "running" ? "Already finished: " : "Stopped: ";
				return result(`${prefix}${formatJobLine(job)}\nlog: ${job.logPath}`, brief(job));
			},
		} as any);

		pi.registerCommand("jobs", {
			description: "List background jobs; `/jobs kill <id>` stops one",
			handler: async (args: string, ctx: any) => {
				const [sub, id] = args.trim().split(/\s+/);
				if (sub === "kill") {
					if (!id) return ctx.ui.notify("Usage: /jobs kill <id>", "warning");
					try {
						const job = await manager.kill(id);
						ctx.ui.notify(`Stopped: ${formatJobLine(job)}`, "info");
					} catch (err) {
						ctx.ui.notify((err as Error).message, "error");
					}
					return;
				}
				if (sub) return ctx.ui.notify("Usage: /jobs [kill <id>]", "warning");
				ctx.ui.notify(`${formatJobList(manager.list())}\nlogs: ${logRoot}`, "info");
			},
		});
	};
}

export default createJobsExtension();
