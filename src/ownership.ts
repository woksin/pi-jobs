/** Process-wide ownership survives module replacement, but never a Pi process restart. */
import { CUSTOM_TYPE, type Delivery } from "./delivery.ts";
import type { JobManager, JobSnapshot } from "./jobs.ts";

export interface Owner {
	version: 2;
	reloadTimer?: ReturnType<typeof setTimeout>;
	manager: JobManager;
	delivery: Delivery<JobSnapshot>;
	/** Undefined while reload is between shutdown and session_start. */
	token?: object;
	alive: () => boolean | undefined;
}

const KEY = Symbol.for("pi-jobs.sessionOwners.v2");
export function sessionOwners(): Map<string, Owner> {
	const global = globalThis as unknown as Record<symbol, Map<string, Owner>>;
	return global[KEY] ??= new Map();
}

/** Validate the handoff protocol rather than assuming a prior module has today's methods. */
export function compatibleOwner(owner: any): owner is Owner {
	const methods = (object: any, names: string[]) => names.every(name => typeof object?.[name] === "function");
	return owner?.version === 2 && typeof owner.alive === "function"
		&& methods(owner.manager, ["start", "watch", "get", "list", "output", "kill", "shutdown", "killAllSync", "advanceSequence", "notificationTail"])
		&& methods(owner.delivery, ["add", "suspend", "rebind", "dispose", "onAgentStart", "onAgentEnd", "onAgentSettled", "onBusyEnd", "confirm"]);
}

async function stopOwner(owner: any): Promise<void> {
	try {
		if (typeof owner.delivery?.dispose === "function") owner.delivery.dispose();
	} finally {
		try {
			if (typeof owner.manager?.shutdown === "function") await owner.manager.shutdown();
		} finally {
			if (typeof owner.manager?.killAllSync === "function") owner.manager.killAllSync();
		}
	}
}

/** Only this session's suspended owner may be adopted or retired as incompatible. */
export async function takeReloadOwner(sessionId: string): Promise<{ owner?: Owner; incompatible?: boolean; dropped?: JobSnapshot[] }> {
	const owners = sessionOwners();
	const legacy = (globalThis as any)[Symbol.for("pi-jobs.sessionOwners.v1")];
	const source = owners.has(sessionId) ? owners : legacy instanceof Map ? legacy : undefined;
	const owner = source?.get(sessionId);
	if (!owner || owner.token) return {};
	clearTimeout(owner.reloadTimer);
	if (compatibleOwner(owner)) return { owner };
	const dropped = typeof owner.manager?.list === "function" ? owner.manager.list().filter((job: JobSnapshot) => job.status === "running") : [];
	source.delete(sessionId);
	await stopOwner(owner);
	return { incompatible: true, dropped };
}

/** Reload is a bounded handoff, not permission to leave work ownerless indefinitely. */
export function expireReloadOwner(sessionId: string, owner: Owner, timeoutMs = 5 * 60_000, owners = sessionOwners()): void {
	clearTimeout(owner.reloadTimer);
	owner.reloadTimer = setTimeout(() => {
		if (owners.get(sessionId) !== owner || owner.token) return;
		owners.delete(sessionId);
		console.warn(`pi-jobs: session ${sessionId} reload handoff expired; stopping its jobs/watches.`);
		void stopOwner(owner).catch(error => console.error(`pi-jobs: reload cleanup failed for ${sessionId}: ${error}`));
	}, timeoutMs);
	owner.reloadTimer.unref();
}

/** Only a stale runtime is proof of a missing owner; a reload in progress is not. */
export async function stopOrphans(owners = sessionOwners()): Promise<string[]> {
	const notices: string[] = [];
	for (const [sessionId, owner] of owners) {
		if (!owner.token || typeof owner.alive !== "function" || owner.alive() !== false) continue;
		const jobs = owner.manager.list().filter(job => job.status === "running");
		owners.delete(sessionId);
		owner.delivery.dispose();
		await owner.manager.shutdown();
		if (jobs.length) notices.push(`pi-jobs: owner session ${sessionId} is gone; stopped orphaned ${jobs.map(job => `${job.kind} ${job.id} (log: ${job.logPath})`).join(", ")}.`);
	}
	return notices;
}

/** Last recorded state, not proof of liveness: old versions stopped work without recording it. */
export function historicalRunningJobs(entries: readonly any[]): JobSnapshot[] {
	const jobs = new Map<string, JobSnapshot>();
	const record = (job: any) => {
		if (typeof job?.id === "string" && typeof job.command === "string") jobs.set(job.id, job);
	};
	for (const entry of entries) {
		const message = entry?.type === "message" ? entry.message : entry?.type === "custom_message" ? { ...entry, role: "custom" } : undefined;
		if (message?.role === "toolResult" && ["job_start", "job_watch", "job_list", "job_output", "job_kill"].includes(message.toolName)) {
			record(message.details);
			for (const job of message.details?.jobs ?? []) record(job);
		}
		if (message?.role === "custom" && message.customType === CUSTOM_TYPE) {
			for (const completion of message.details?.completions ?? []) record(completion?.job);
		}
	}
	return [...jobs.values()].filter(job => job.status === "running");
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
