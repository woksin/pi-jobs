/** Model- and user-facing text (pure). */
import { constants } from "node:os";
import type { JobSnapshot } from "./jobs.ts";
import { tailBuffer, type Tail } from "./tail.ts";

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function oneLine(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function jobTitle(job: JobSnapshot): string {
	return job.label ? job.label : oneLine(job.command, 80);
}

const SIGNAL_NAMES = new Map<number, string>(Object.entries(constants.signals).map(([name, n]) => [n as number, name]));

/**
 * "exit 0", "exit 143 (likely SIGTERM)", "signal SIGKILL", or "" when unknown. A status above
 * 128 is how bash reports death by signal (128+n), but a command can also exit with it, so the
 * signal is only named as likely. `signal` is set only when it was observed directly.
 */
export function exitText(exitCode: number | null | undefined, signal: string | null | undefined): string {
	if (typeof exitCode === "number") {
		const likely = exitCode > 128 ? SIGNAL_NAMES.get(exitCode - 128) : undefined;
		return likely ? `exit ${exitCode} (likely ${likely})` : `exit ${exitCode}`;
	}
	return signal ? `signal ${signal}` : "";
}

function durationOf(job: JobSnapshot, now: number): number {
	return (job.endedAt ?? now) - job.startedAt;
}

/** The single completion notification that wakes the agent. */
export function formatNotification(job: JobSnapshot, tail: Tail, now = Date.now(), event?: "match" | "terminal"): string {
	if (job.kind === "watch" && job.status === "matched" && event !== "match") {
		const head = `Watch ${job.id} matched (${jobTitle(job)}, after ${formatDuration(durationOf(job, now))})`;
		if (tail.text === "") return `${head}.`;
		const short = tailBuffer(Buffer.from(tail.text, "utf8"), 10, 1024);
		return `${head}: ${short.text}`;
	}
	const kind = job.kind === "subscription" ? "Subscription" : job.kind === "watch" ? "Watch" : "Job";
	const status = event === "match" ? `match #${job.matchSequence}` : job.status.replace("_", " ");
	const head = [`${kind} ${job.id} ${status}: ${jobTitle(job)}`];
	if (job.kind === "subscription") head.push(`lane: ${job.lane} · inbox: ${job.inboxDir}`);
	const facts: string[] = [];
	if (job.kind === "watch") {
		facts.push(`until ${job.until}`, `${job.checks ?? 0} check${job.checks === 1 ? "" : "s"}`);
		const last = job.lastCheck;
		if (last) {
			const status = last.timedOut ? "last check timed out" : `last check ${exitText(last.exitCode, last.signal)}`;
			facts.push(status);
		}
	} else {
		const exit = exitText(job.exitCode, job.signal);
		if (exit) facts.push(exit);
	}
	facts.push(`after ${formatDuration(durationOf(job, now))}`);
	if (job.status === "timed_out") facts.push(`timeout ${job.timeoutSeconds}s` + (job.quietTimeouts && job.quietTimeouts > 1 ? ` x ${(job.quietRearms ?? 0) + 1} periods` : ""));
	head.push(facts.join(" · "));
	if (job.label) head.push(`${job.kind !== "command" ? "check" : "command"}: ${oneLine(job.command, 200)}`);
	head.push(`log: ${job.logPath}${job.logTruncated ? " (truncated at the size cap)" : ""}`);
	if (job.logError) head.push(`log write error: ${job.logError} (later output was not logged)`);
	if (job.error) head.push(`error: ${job.error}`);
	const which = job.kind === "subscription" ? "captured check output" : job.kind === "watch" ? "last check output" : "output";
	if (tail.text === "") head.push(`(no ${which})`);
	else head.push(`${tail.truncated ? `${which} (tail)` : which}:`, tail.text);
	return head.join("\n");
}

export interface FormattedBatch {
	/** Message content parts; joined they read as one message. */
	parts: string[];
	/** Index into `parts` of each item's own block (so a context filter can drop one block). */
	partOf: number[];
}

/**
 * One wake-up message for one or more completions. A single completion keeps the plain
 * format; several are numbered blocks, one content part each, under a header part.
 */
export function formatBatch(items: { job: JobSnapshot; tail: Tail; event?: "match" | "terminal" }[], now = Date.now()): FormattedBatch {
	if (items.length === 1) return { parts: [formatNotification(items[0].job, items[0].tail, now, items[0].event)], partOf: [0] };
	const n = items.length;
	const blocks = items.map((it, i) => `[${i + 1}/${n}] ${formatNotification(it.job, it.tail, now, it.event)}${i < n - 1 ? "\n\n" : ""}`);
	return { parts: [`${n} background ${items.some(it => it.event) ? "job events" : "jobs finished"}:\n\n`, ...blocks], partOf: items.map((_, i) => i + 1) };
}

export function formatJobLine(job: JobSnapshot, now = Date.now()): string {
	const kind = job.kind === "subscription" ? "subscription" : job.kind === "watch" ? "watch" : "job";
	const parts = [`${job.id}`, kind, job.status];
	if (job.status !== "running") {
		const exit = job.kind === "watch" ? "" : exitText(job.exitCode, job.signal);
		if (exit) parts.push(exit);
	} else if (job.kind === "watch") {
		parts.push(`${job.checks ?? 0} checks`);
	}
	parts.push(formatDuration(durationOf(job, now)));
	return `${parts.join(" · ")} — ${jobTitle(job)}`;
}

const RECENT_FINISHED = 5;

export function formatJobList(jobs: JobSnapshot[], now = Date.now(), all = false): string {
	if (jobs.length === 0) return "No background jobs in this session.";
	const running = jobs.filter(j => j.status === "running");
	const finished = jobs.filter(j => j.status !== "running")
		.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
	const done = all ? finished : finished.slice(0, RECENT_FINISHED);
	const older = finished.length - done.length;
	const out: string[] = [];
	if (running.length) out.push(`Running (${running.length}):`, ...running.map(j => `  ${formatJobLine(j, now)}`));
	if (done.length) out.push(`Recent (${done.length}):`, ...done.map(j => `  ${formatJobLine(j, now)}`));
	if (older > 0) out.push(`… ${older} older finished (job_list all: true)`);
	return out.join("\n");
}
