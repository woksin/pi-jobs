/** Process-wide ownership survives module replacement, but never a Pi process restart. */
import { CUSTOM_TYPE, type Delivery } from "./delivery.ts";
import type { JobManager, JobSnapshot } from "./jobs.ts";

export interface Owner {
	manager: JobManager;
	delivery: Delivery<JobSnapshot>;
	/** Undefined while reload is between shutdown and session_start. */
	token?: object;
	alive: () => boolean | undefined;
}

const KEY = Symbol.for("pi-jobs.sessionOwners.v1");
export function sessionOwners(): Map<string, Owner> {
	const global = globalThis as unknown as Record<symbol, Map<string, Owner>>;
	return global[KEY] ??= new Map();
}

/** Only a stale runtime is proof of a missing owner; a reload in progress is not. */
export async function stopOrphans(owners = sessionOwners()): Promise<string[]> {
	const notices: string[] = [];
	for (const [sessionId, owner] of owners) {
		if (!owner.token || owner.alive() !== false) continue;
		const jobs = owner.manager.list().filter(job => job.status === "running");
		owners.delete(sessionId);
		owner.delivery.dispose();
		await owner.manager.shutdown();
		if (jobs.length) notices.push(`pi-jobs: owner session ${sessionId} is gone; stopped orphaned ${jobs.map(job => `${job.kind} ${job.id} (log: ${job.logPath})`).join(", ")}.`);
	}
	return notices;
}

/** Session history provides a high-water mark even when the old manager is unavailable. */
export function highestJobId(entries: readonly any[]): number {
	let highest = 0;
	const consider = (id: unknown) => {
		const match = typeof id === "string" ? /^j(\d+)$/.exec(id) : undefined;
		if (match && Number.isSafeInteger(Number(match[1]))) highest = Math.max(highest, Number(match[1]));
	};
	for (const entry of entries) {
		const m = entry?.type === "message" ? entry.message : entry?.type === "custom_message" ? { ...entry, role: "custom" } : undefined;
		if (m?.role === "toolResult" && ["job_start", "job_watch", "job_list", "job_output", "job_kill"].includes(m.toolName)) {
			consider(m.details?.id);
			for (const job of m.details?.jobs ?? []) consider(job?.id);
			if (m.toolName === "job_start" || m.toolName === "job_watch") {
				const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => p.text ?? "").join("\n");
				consider(/^Started (?:job|watch) (j\d+)\b/.exec(text)?.[1]);
			}
		}
		if (m?.role === "custom" && m.customType === CUSTOM_TYPE) {
			for (const c of m.details?.completions ?? []) consider(c?.job?.id);
		}
	}
	return highest;
}
