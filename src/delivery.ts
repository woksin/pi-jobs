/**
 * Completion delivery through pi's native paths only (no timers, no polling).
 *
 * pi has no atomic "wake the agent" or reservation API, so an extension cannot make delivery
 * exactly-once. What this module does guarantee:
 *  - Normal case: every completion is delivered at least once.
 *  - The model sees each completion id at most once per context: `dedupeCompletions` strips
 *    already-shown completion blocks, keyed on unique ids. This holds per completion for
 *    messages in the current indexed format (`details.completions[].part`); older messages
 *    without part indices can only be stubbed as a whole, once all their ids were seen.
 *  - Across Escape/abort: best effort, with at most one resend per dropped follow-up.
 * Known pi-side races are documented in UPSTREAM-ISSUES.md rather than papered over here.
 *
 * Paths, all through `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`:
 *  - Idle: pi starts a run with the completion as its prompt.
 *  - A run is active (agent_start … agent_settled), or pi is busy without one (compaction,
 *    branch summary): hold it. At the next non-aborted agent_end, everything held goes out as
 *    ONE follow-up (batching), which pi consumes in the continuation of that run.
 *  - agent_settled: the run is over; deliver what is held only if pi is idle. pi may already be
 *    busy again (an earlier agent_settled handler can start a compaction); then wait.
 *  - End of busy work: `session_compact` and `session_tree` fire before pi clears its busy
 *    state, so they get one setImmediate, idle-checked drain; `session_compact_failed` fires
 *    after it and drains at once. If pi is still busy then, the next agent event drains.
 *  - Recovery: a follow-up we queued that has no message_end confirmation when its run
 *    settles (Escape/clearQueue dropped it, or an abort stranded it) is sent once more, as its
 *    own batch (never merged), through the same idle-checked drain.
 *  - A throw from pi (stale context after reload/session replacement) is permanent: the
 *    delivery is disposed and nothing is retried.
 */

/** Custom message type of completion messages. */
export const CUSTOM_TYPE = "pi-jobs";

export interface Completion<T> {
	/** Globally unique (UUID); the only key used for deduplication. */
	completionId: string;
	payload: T;
}

export interface DeliveryHost<T> {
	/** pi's idle state. Throws if the context is stale. */
	isIdle(): boolean;
	/** Whether the current run was aborted (read in agent_end). */
	aborted(): boolean;
	/** One message, `triggerTurn: true, deliverAs: "followUp"`. Throws if the context is stale. */
	send(deliveryId: string, items: Completion<T>[]): void;
	/** Called once when delivery stops for good (stale context) with what was not sent. */
	lost?(items: Completion<T>[]): void;
}

export class Delivery<T> {
	private host: DeliveryHost<T>;
	private suspended = false;
	private binding = 0;
	private readonly newId: () => string;
	private held: Completion<T>[] = [];
	/** Unconfirmed follow-ups awaiting their single resend, one batch each. */
	private recovery: Completion<T>[][] = [];
	/**
	 * Follow-ups in pi's queue awaiting message_end. Recovery resends through the idle path,
	 * which is never tracked here, so each follow-up is resent at most once.
	 */
	private readonly queued = new Map<string, Completion<T>[]>();
	private runActive = false;
	private disposed = false;

	constructor(host: DeliveryHost<T>, newId: () => string = () => crypto.randomUUID()) {
		this.host = host;
		this.newId = newId;
	}

	get heldCount(): number {
		return this.held.length + this.recovery.reduce((n, b) => n + b.length, 0);
	}

	private get pending(): boolean {
		return this.held.length > 0 || this.recovery.length > 0;
	}

	add(item: Completion<T>): void {
		if (this.disposed) return;
		this.held.push(item);
		this.drainIfIdle();
	}

	onAgentStart(): void {
		if (!this.disposed && !this.suspended) this.runActive = true;
	}

	onAgentEnd(): void {
		if (this.disposed || this.suspended || (this.held.length === 0 && this.recovery.length === 0)) return;
		let aborted = true;
		try {
			aborted = this.host.aborted();
		} catch {}
		// An aborted run will not consume follow-ups; keep them for agent_settled.
		if (aborted) return;
		for (const batch of this.recovery.splice(0)) this.send(batch, "untracked");
		if (this.held.length) this.send(this.held.splice(0), "followUp");
	}

	/**
	 * The run is over, but pi may already be busy again (e.g. an earlier agent_settled handler
	 * started a compaction): deliver only if idle, otherwise wait for the end of that work.
	 */
	onAgentSettled(): void {
		if (this.disposed || this.suspended) return;
		this.runActive = false;
		for (const items of this.queued.values()) this.recovery.push(items); // kept separate, never merged
		this.queued.clear();
		this.drainIfIdle();
	}

	/**
	 * pi finished non-agent work (compaction: `session_compact`/`session_compact_failed`;
	 * branch summary: `session_tree`). Events emitted before pi clears its busy state get one
	 * deferred, idle-checked drain; events emitted after it (`afterTeardown`) drain at once.
	 */
	onBusyEnd(afterTeardown: boolean): void {
		if (this.disposed || !this.pending) return;
		if (afterTeardown) this.drainIfIdle();
		else setImmediate(() => this.drainIfIdle());
	}

	/** message_end of one of our messages. */
	confirm(deliveryId: string): void {
		this.queued.delete(deliveryId);
	}

	/** Reload keeps completions, but must never call the stale extension API. */
	suspend(): void {
		this.binding++;
		this.suspended = true;
		this.runActive = false;
		for (const items of this.queued.values()) this.recovery.push(items);
		this.queued.clear();
	}

	/** The replacement extension supplies a fresh context and API before draining. */
	rebind(host: DeliveryHost<T>): void {
		this.host = host;
		const binding = ++this.binding;
		// Keep buffering until every extension's session_start handler has run.
		this.suspended = true;
		setImmediate(() => {
			if (this.binding !== binding || this.disposed) return;
			this.suspended = false;
			this.drainIfIdle();
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const lost = [...this.held, ...this.recovery.flat(), ...[...this.queued.values()].flat()];
		this.held = [];
		this.recovery = [];
		this.queued.clear();
		if (lost.length) {
			try {
				this.host.lost?.(lost);
			} catch {}
		}
	}

	private idle(): boolean {
		try {
			return this.host.isIdle();
		} catch {
			this.dispose(); // stale context: permanent
			return false;
		}
	}

	/**
	 * Idle: send recovery batches (separately), then everything held. A send that starts a run
	 * synchronously stops the drain; the rest goes out at that run's agent_end.
	 */
	private drainIfIdle(): void {
		while (!this.disposed && !this.suspended && !this.runActive && this.pending && this.idle()) {
			const recovered = this.recovery.shift();
			this.send(recovered ?? this.held.splice(0), "idle");
		}
	}

	/**
	 * "followUp": sent during a run and tracked for one recovery. "untracked": a recovery
	 * batch sent as a follow-up (never recovered again). "idle": pi starts a run (or defers one
	 * when called from agent_settled).
	 */
	private send(items: Completion<T>[], mode: "idle" | "followUp" | "untracked"): void {
		const deliveryId = this.newId();
		try {
			this.host.send(deliveryId, items);
		} catch {
			this.held.unshift(...items);
			this.dispose(); // pi refused synchronously: the context is stale
			return;
		}
		if (mode === "followUp") this.queued.set(deliveryId, items);
		// An idle send starts a run synchronously; hold what arrives until its agent_end.
		else if (mode === "idle" && !this.runActive && !this.idle()) this.runActive = true;
	}
}

interface ContextMessage {
	role?: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
}

interface CompletionRef {
	completionId: string;
	/** Content part of this completion's block; absent in older single-part messages. */
	part?: number;
}

/** Completions carried by a pi-jobs message (none for other messages or the round-2 format). */
export function completionRefs(message: ContextMessage): CompletionRef[] {
	if (message?.role !== "custom" || message.customType !== CUSTOM_TYPE) return [];
	const list = (message.details as { completions?: { completionId?: unknown; part?: unknown }[] } | undefined)?.completions;
	if (!Array.isArray(list)) return [];
	return list
		.filter(c => typeof c?.completionId === "string" && c.completionId.length > 0)
		.map(c => ({ completionId: c.completionId as string, ...(Number.isInteger(c.part) ? { part: c.part as number } : {}) }));
}

export const DUPLICATE_STUB = "[pi-jobs: this completion was already delivered above; nothing new.]";

function stripped(count: number): string {
	return `[pi-jobs: ${count} completion${count === 1 ? "" : "s"} already shown above omitted.]\n\n`;
}

/**
 * Model-context filter, keyed on unique completion ids only (display handles such as `j1` are
 * never compared). In each pi-jobs message, the block of every completion already shown earlier
 * in the context is removed and replaced by a one-line note; unseen blocks are kept as they
 * are. A message left with no unseen completion becomes a one-line stub (kept, not removed, so
 * the context never ends on an assistant message). Messages without per-block part indices can
 * only be stubbed as a whole, when all their ids were seen. Returns undefined if nothing changed.
 */
export function dedupeCompletions<M extends ContextMessage>(messages: M[]): M[] | undefined {
	const seen = new Set<string>();
	let changed = false;
	const out = messages.map(m => {
		const refs = completionRefs(m);
		if (refs.length === 0) return m;
		const repeats = refs.filter(r => seen.has(r.completionId));
		for (const r of refs) seen.add(r.completionId);
		if (repeats.length === 0) return m;
		if (repeats.length === refs.length) {
			changed = true;
			return { ...m, content: [{ type: "text", text: DUPLICATE_STUB }] };
		}
		const parts = Array.isArray(m.content) ? m.content : undefined;
		const drop = new Set(repeats.map(r => r.part));
		if (!parts || drop.has(undefined) || [...drop].some(i => i! >= parts.length)) return m; // cannot split: keep whole
		changed = true;
		// Drop the repeated blocks and the batch header (its count is stale); say what was omitted.
		const blockParts = new Set(refs.map(r => r.part));
		const kept = parts.map((part, i) => ({ part, i })).filter(({ i }) => !drop.has(i) && (blockParts.has(i) || i > 0));
		// Keep details consistent with the new content (idempotent re-filtering): drop the omitted
		// completions and point the remaining ones at their new part index (after the note).
		const newIndex = new Map(kept.map(({ i }, k) => [i, k + 1]));
		const omitted = new Set(repeats.map(r => r.completionId));
		const details = m.details as { completions: { completionId?: unknown; part?: unknown }[] };
		const completions = details.completions
			.filter(c => !omitted.has(c?.completionId as string))
			.map(c => (newIndex.has(c?.part as number) ? { ...c, part: newIndex.get(c.part as number) } : c));
		return { ...m, content: [{ type: "text", text: stripped(repeats.length) }, ...kept.map(k => k.part)], details: { ...details, completions } };
	});
	return changed ? out : undefined;
}
