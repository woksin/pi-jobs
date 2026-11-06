/**
 * Completion delivery through pi's native paths; only opt-in subscriptions use an idle timer.
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

import { IDLE_WINDOW_MS, type SubscriptionRecord } from "./subscription.ts";

/** Custom message type of completion messages. */
export const CUSTOM_TYPE = "pi-jobs";

export interface Completion<T> {
	/** Globally unique (UUID); the only key used for deduplication. */
	completionId: string;
	payload: T;
	/** Opt-in policy; ordinary completions retain their timer-free behavior. */
	subscription?: {
		record: SubscriptionRecord;
		retained(): boolean;
		eligible(): boolean;
		sent(): void;
		confirm(): void;
	};
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
	subscriptionError?(record: SubscriptionRecord, diagnostic: string): void;
}

export class Delivery<T> {
	readonly subscriptionProtocol = 1;
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
	private readonly receipts = new Map<string, Completion<T>[]>();
	private windowAt?: number;
	private windowTimer?: NodeJS.Timeout;

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
		if (!this.disposed && !this.suspended) {
			this.clearWindowTimer();
			this.runActive = true;
		}
	}

	onAgentEnd(): void {
		if (this.disposed || this.suspended || (this.held.length === 0 && this.recovery.length === 0)) return;
		let aborted = true;
		try {
			aborted = this.host.aborted();
		} catch {}
		// An aborted run will not consume follow-ups; keep them for agent_settled.
		if (aborted) return;
		this.clearWindowTimer();
		for (const batch of this.recovery) {
			const eligible = this.takeEligible(batch);
			if (eligible.length) this.send(eligible, "untracked");
		}
		this.recovery = this.recovery.filter(batch => batch.length);
		const eligible = this.takeEligible(this.held);
		if (eligible.length) this.send(eligible, "followUp");
		this.resetWindowIfEmpty();
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
		const received = this.receipts.get(deliveryId);
		if (!received) return;
		const ids = new Set(received.map(item => item.completionId));
		for (const item of received) item.subscription?.confirm();
		for (const [id, items] of this.receipts) {
			const remaining = items.filter(item => !ids.has(item.completionId));
			if (remaining.length) this.receipts.set(id, remaining);
			else this.receipts.delete(id);
		}
		// A receipt of the original also removes a not-yet-sent recovery reference.
		for (const batch of this.recovery) this.removeConfirmed(batch);
		this.recovery = this.recovery.filter(batch => batch.length);
	}

	/** Always use the current binding, never an API captured by the original producer. */
	reportSubscriptionError(record: SubscriptionRecord, diagnostic: string): void {
		if (!this.suspended && !this.disposed) this.host.subscriptionError?.(record, diagnostic);
	}

	/** Remove explicitly reconciled records before their reserved capacity is released. */
	pruneSubscriptions(): void {
		this.removeConfirmed(this.held);
		for (const batch of this.recovery) this.removeConfirmed(batch);
		this.recovery = this.recovery.filter(batch => batch.length);
		for (const map of [this.receipts, this.queued]) {
			for (const [id, items] of map) {
				this.removeConfirmed(items);
				if (!items.length) map.delete(id);
			}
		}
		this.resetWindowIfEmpty();
	}

	/** Reload keeps completions, but must never call the stale extension API. */
	suspend(): void {
		this.binding++;
		this.suspended = true;
		this.clearWindowTimer();
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
		this.clearWindowTimer();
		const lost = [...new Set([...this.held, ...this.recovery.flat(), ...[...this.queued.values()].flat(), ...[...this.receipts.values()].flat()])];
		this.receipts.clear();
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
			const urgent = [...this.held, ...this.recovery.flat()].some(item => !item.subscription);
			const eligibleSubscription = [...this.held, ...this.recovery.flat()].some(item => item.subscription?.retained() && item.subscription.eligible());
			if (eligibleSubscription && this.windowAt === undefined) this.windowAt = Date.now() + IDLE_WINDOW_MS;
			const allowSubscription = urgent || (this.windowAt !== undefined && Date.now() >= this.windowAt);
			let items: Completion<T>[] = [];
			for (const batch of this.recovery) {
				items = this.takeEligible(batch, allowSubscription);
				if (items.length) break;
			}
			this.recovery = this.recovery.filter(batch => batch.length);
			if (!items.length) items = this.takeEligible(this.held, allowSubscription);
			if (!items.length) {
				if (eligibleSubscription && !allowSubscription) this.armWindow();
				break;
			}
			this.send(items, "idle");
			this.resetWindowIfEmpty();
		}
	}

	private removeConfirmed(items: Completion<T>[]): void {
		for (let i = items.length - 1; i >= 0; i--) {
			if (items[i].subscription && !items[i].subscription!.retained()) items.splice(i, 1);
		}
	}

	/** Leave parked records in place, without head-of-line-blocking ordinary completions. */
	private takeEligible(items: Completion<T>[], allowSubscription = true): Completion<T>[] {
		this.removeConfirmed(items);
		const selected: Completion<T>[] = [];
		for (let i = 0; i < items.length;) {
			const policy = items[i].subscription;
			if (!policy || (allowSubscription && policy.eligible())) selected.push(...items.splice(i, 1));
			else i++;
		}
		return selected;
	}

	private clearWindowTimer(): void {
		clearTimeout(this.windowTimer);
		this.windowTimer = undefined;
	}

	private armWindow(): void {
		if (this.windowTimer || this.windowAt === undefined) return;
		this.windowTimer = setTimeout(() => {
			this.windowTimer = undefined;
			this.drainIfIdle();
		}, Math.max(0, this.windowAt - Date.now()));
		this.windowTimer.unref();
	}

	private resetWindowIfEmpty(): void {
		if (this.pending) return;
		this.windowAt = undefined;
		this.clearWindowTimer();
	}

	/**
	 * "followUp": sent during a run and tracked for one recovery. "untracked": a recovery
	 * batch sent as a follow-up (never recovered again). "idle": pi starts a run (or defers one
	 * when called from agent_settled).
	 */
	private send(items: Completion<T>[], mode: "idle" | "followUp" | "untracked"): void {
		// Gate again at the actual send boundary, including recovery and rebind routes.
		const eligible = this.takeEligible(items);
		if (items.length) this.held.push(...items);
		items = eligible;
		if (!items.length) return;
		const deliveryId = this.newId();
		const subscriptions = items.filter(item => item.subscription);
		if (subscriptions.length) {
			this.receipts.set(deliveryId, subscriptions);
			for (const item of subscriptions) item.subscription!.sent();
		}
		try {
			this.host.send(deliveryId, items);
		} catch {
			this.held.unshift(...items);
			this.dispose(); // pi refused synchronously: the context is stale
			return;
		}
		if (mode === "followUp") {
			this.removeConfirmed(items);
			if (items.length) this.queued.set(deliveryId, items);
		}
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
