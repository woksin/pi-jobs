/** Delivery and the context filter with a fake host (no pi, no processes). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CUSTOM_TYPE, dedupeCompletions, Delivery, DUPLICATE_STUB, type Completion } from "../src/delivery.ts";

function host() {
	const state = {
		idle: true,
		aborted: false,
		startRunOnSend: true,
		stale: false,
		sends: [] as { id: string; ids: string[] }[],
		lost: [] as string[],
	};
	const h = {
		isIdle: () => {
			if (state.stale) throw new Error("stale ctx");
			return state.idle;
		},
		aborted: () => state.aborted,
		send: (id: string, items: Completion<string>[]) => {
			if (state.stale) throw new Error("stale ctx");
			state.sends.push({ id, ids: items.map(i => i.completionId) });
			if (state.startRunOnSend && state.idle) state.idle = false;
		},
		lost: (items: Completion<string>[]) => state.lost.push(...items.map(i => i.completionId)),
	};
	let n = 0;
	const d = new Delivery<string>(h, () => `d${++n}`);
	const c = (id: string): Completion<string> => ({ completionId: id, payload: id });
	return { state, d, c };
}

/** Count timers created while `fn` runs. */
function countTimers(fn: () => void): number {
	const g = globalThis as any;
	const saved = { setTimeout: g.setTimeout, setInterval: g.setInterval, setImmediate: g.setImmediate };
	let count = 0;
	for (const k of Object.keys(saved)) g[k] = (...a: any[]) => (count++, (saved as any)[k](...a));
	try {
		fn();
	} finally {
		Object.assign(g, saved);
	}
	return count;
}

test("idle: a completion is sent at once and starts a run", () => {
	const { state, d, c } = host();
	d.add(c("a"));
	assert.deepEqual(state.sends, [{ id: "d1", ids: ["a"] }]);
});

test("a run started by our send holds the next completion until its agent_end (batching)", () => {
	const { state, d, c } = host();
	d.add(c("a"));
	d.add(c("b"));
	d.add(c("c"));
	assert.equal(state.sends.length, 1);
	d.onAgentStart();
	d.onAgentEnd();
	assert.deepEqual(state.sends[1].ids, ["b", "c"]);
});

test("during a run: held until a non-aborted agent_end, then one follow-up", () => {
	const { state, d, c } = host();
	state.idle = false;
	d.onAgentStart();
	d.add(c("a"));
	d.add(c("b"));
	assert.equal(state.sends.length, 0);
	d.onAgentEnd();
	assert.deepEqual(state.sends, [{ id: "d1", ids: ["a", "b"] }]);
	d.confirm("d1");
	state.idle = true;
	d.onAgentSettled();
	assert.equal(state.sends.length, 1, "a confirmed follow-up is never resent");
});

test("aborted run: nothing is queued at agent_end; sent at agent_settled", () => {
	const { state, d, c } = host();
	state.idle = false;
	d.onAgentStart();
	d.add(c("a"));
	state.aborted = true;
	d.onAgentEnd();
	assert.equal(state.sends.length, 0);
	state.idle = true;
	state.aborted = false;
	d.onAgentSettled();
	assert.deepEqual(state.sends.map(s => s.ids), [["a"]]);
});

test("a dropped follow-up is resent once, alone (never mixed with new completions)", () => {
	const { state, d, c } = host();
	state.idle = false;
	d.onAgentStart();
	d.add(c("a"));
	d.onAgentEnd(); // queued as follow-up; then Escape clears pi's queue
	d.add(c("b")); // arrives after the last agent_end
	state.idle = true;
	d.onAgentSettled(); // resend of [a] starts a run; [b] waits for that run's agent_end
	assert.deepEqual(state.sends.map(s => s.ids), [["a"], ["a"]]);
	d.onAgentStart();
	d.onAgentEnd();
	assert.deepEqual(state.sends.map(s => s.ids), [["a"], ["a"], ["b"]]);
	d.confirm(state.sends[2].id);
	state.idle = true;
	d.onAgentSettled();
	assert.equal(state.sends.length, 3, "the resend of [a] is never tracked, so it is never resent again");
});

test("agent_settled while pi is busy again (earlier handler started a compaction): hold, drain after", async () => {
	const { state, d, c } = host();
	state.idle = false;
	d.onAgentStart();
	d.add(c("a"));
	d.onAgentEnd(); // follow-up [a] queued, then dropped
	d.add(c("b"));
	d.add(c("c"));
	state.aborted = true;
	d.onAgentEnd(); // aborted: [b, c] stay held
	// state.idle stays false: an earlier agent_settled handler started a compaction
	d.onAgentSettled();
	assert.deepEqual(state.sends.map(s => s.ids), [["a"]], "nothing may start a run while pi is busy");
	state.idle = true;
	state.startRunOnSend = false; // compaction end: the events drain in order without a new run
	d.onBusyEnd(false);
	await new Promise(r => setImmediate(r));
	assert.deepEqual(state.sends.map(s => s.ids), [["a"], ["a"], ["b", "c"]], "recovery batch first and separate, then the held batch");
});

test("no timers, and nothing is ever resent because time passed", async () => {
	const { state, d, c } = host();
	state.startRunOnSend = false; // a send pi defers: the session looks idle afterwards
	const timers = countTimers(() => {
		d.add(c("a"));
		d.onAgentStart();
		d.add(c("b"));
		d.onAgentEnd();
		d.onAgentSettled();
	});
	assert.equal(timers, 0);
	const before = state.sends.length;
	await new Promise(r => setTimeout(r, 200));
	assert.equal(state.sends.length, before);
});

test("busy without a run (compaction, branch summary): held; one deferred re-check after the end event", async () => {
	const { state, d, c } = host();
	state.idle = false;
	d.add(c("a"));
	assert.equal(state.sends.length, 0);
	assert.equal(countTimers(() => d.onBusyEnd(false)), 1, "exactly one setImmediate, no loop");
	await new Promise(r => setImmediate(r));
	assert.equal(state.sends.length, 0, "still busy: keep holding, no retry loop");
	state.idle = true;
	d.onBusyEnd(true); // session_compact_failed fires after pi cleared its state
	assert.deepEqual(state.sends.map(s => s.ids), [["a"]]);
});

test("stale context is permanent: dispose, report the loss, never retry", () => {
	const { state, d, c } = host();
	state.idle = false;
	d.onAgentStart();
	d.add(c("a"));
	state.stale = true;
	d.onAgentEnd(); // send throws
	assert.deepEqual(state.lost, ["a"]);
	state.stale = false;
	state.idle = true;
	d.add(c("b"));
	d.onAgentSettled();
	assert.equal(state.sends.length, 0);
});

test("stale context detected by isIdle: disposed, nothing sent", () => {
	const { state, d, c } = host();
	state.stale = true;
	d.add(c("a"));
	assert.equal(state.sends.length, 0);
	assert.deepEqual(state.lost, ["a"]);
});

/** A pi-jobs message in the current format: header part + one part per completion. */
const msg = (ids: string[]) => {
	const single = ids.length === 1;
	return {
		role: "custom",
		customType: CUSTOM_TYPE,
		content: single ? [{ type: "text", text: `block ${ids[0]}` }] : [{ type: "text", text: "header" }, ...ids.map(id => ({ type: "text", text: `block ${id}` }))],
		details: { deliveryId: "x", completions: ids.map((completionId, i) => ({ completionId, part: single ? 0 : i + 1, job: { id: "j1" } })) },
	};
};
const texts = (m: any) => m.content.map((p: any) => p.text);

test("context filter: dedupes on completion ids only, never on the job handle", () => {
	const legacy = { role: "custom", customType: CUSTOM_TYPE, content: "old j1", details: { deliveryId: "old", jobs: [{ id: "j1" }] } };
	const messages = [legacy, msg(["u1"]), msg(["u2"])]; // three different j1 completions (resume/fork)
	assert.equal(dedupeCompletions(messages), undefined);
});

test("context filter: each completion block reaches the model at most once", () => {
	const out = dedupeCompletions([msg(["u1"]), msg(["u1", "u2"]), msg(["u2", "u3", "u1"]), msg(["u1", "u2"]), { role: "user", content: "hi" }])!;
	assert.deepEqual(texts(out[0]), ["block u1"]);
	assert.deepEqual(texts(out[1]), ["[pi-jobs: 1 completion already shown above omitted.]\n\n", "block u2"], "seen block stripped, unseen kept");
	assert.deepEqual(texts(out[2]), ["[pi-jobs: 2 completions already shown above omitted.]\n\n", "block u3"]);
	assert.deepEqual(texts(out[3]), [DUPLICATE_STUB], "nothing unseen: stub, not removed");
	assert.equal(out.length, 5);
	const shown = out.flatMap(m => (Array.isArray((m as any).content) ? texts(m) : [])).join("|");
	for (const id of ["u1", "u2", "u3"]) assert.equal(shown.split(`block ${id}`).length - 1, 1, `${id} shown once`);
});

test("context filter is idempotent and never loses an unseen block", () => {
	const ctx = [msg(["a"]), msg(["a", "b", "c"]), msg(["b", "d"]), msg(["c", "d", "e"])];
	const once = dedupeCompletions(ctx)!;
	assert.equal(dedupeCompletions(once), undefined, "filtering the filtered context changes nothing");
	// details stay consistent with content: every remaining ref points at its own block
	for (const m of once as any[]) {
		const refs = m.details.completions;
		if (texts(m)[0] === DUPLICATE_STUB) continue;
		for (const r of refs) assert.equal(texts(m)[r.part], `block ${r.completionId}`);
	}
	const shown = once.flatMap(m => texts(m)).join("|");
	for (const id of ["a", "b", "c", "d", "e"]) assert.equal(shown.split(`block ${id}`).length - 1, 1, `${id} shown exactly once`);
	assert.deepEqual(texts(once[1]), ["[pi-jobs: 1 completion already shown above omitted.]\n\n", "block b", "block c"]);
	assert.deepEqual(once[1].details.completions.map((c: any) => [c.completionId, c.part]), [["b", 1], ["c", 2]]);
});

test("context filter: a message without part indices can only be stubbed as a whole", () => {
	const old = (ids: string[]) => ({ role: "custom", customType: CUSTOM_TYPE, content: [{ type: "text", text: ids.join(",") }], details: { completions: ids.map(completionId => ({ completionId })) } });
	const out = dedupeCompletions([old(["u1"]), old(["u1", "u2"]), old(["u1"])])!;
	assert.deepEqual(texts(out[1]), ["u1,u2"], "cannot split an unindexed message");
	assert.deepEqual(texts(out[2]), [DUPLICATE_STUB]);
});

test("reload suspends stale API calls and rebinds held and unconfirmed completions", async () => {
	const { state, d, c } = host();
	state.idle = false;
	d.onAgentStart();
	d.add(c("unconfirmed"));
	d.onAgentEnd();
	d.add(c("held"));
	d.suspend();
	state.stale = true;
	d.add(c("during-reload"));
	d.onAgentStart();
	d.onAgentEnd();
	d.onAgentSettled();
	d.onBusyEnd(true);
	assert.equal(state.sends.length, 1);
	assert.equal(d.disposed, false);
	const received: string[][] = [];
	d.rebind({ isIdle: () => true, aborted: () => false, send: (_id, items) => { received.push(items.map(i => i.completionId)); } });
	assert.deepEqual(received, []); // Other session_start handlers run before this drain.
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(received, [["unconfirmed"], ["held", "during-reload"]]);
	assert.equal(state.lost.length, 0);
});


test("a deferred rebind cannot resume a second reload handoff", async () => {
	const { d, c } = host();
	d.suspend();
	d.add(c("pending"));
	let sends = 0;
	d.rebind({ isIdle: () => true, aborted: () => false, send: () => { sends++; } });
	d.suspend();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(sends, 0);
	d.dispose();
});
