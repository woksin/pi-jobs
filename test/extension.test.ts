/** End-to-end through the registered tools with a fake ExtensionAPI and real processes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobsExtension, CUSTOM_TYPE, liveManagers } from "../src/extension.ts";
import { piAiEntry, runtimeDirectory } from "./runtime.ts";
import defaultExtension from "../src/extension.ts";
import { alive, readPid, sleep, tempDir, waitUntil } from "./helpers.ts";
import { JobManager } from "../src/jobs.ts";
import { sessionOwners } from "../src/ownership.ts";

interface Sent {
	message: { customType: string; content: { type: string; text: string }[]; display: boolean; details: any };
	options: { triggerTurn?: boolean; deliverAs?: string };
}

function fakePi(throwOnSend = false, sessionId = randomUUID(), entries: any[] = []) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, ((...a: any[]) => any)[]>();
	const sent: Sent[] = [];
	const notes: { text: string; level: string }[] = [];
	// Session state as pi would report it; startRunOnSend mimics pi starting a run on send.
	const state = { idle: true, startRunOnSend: false, stale: false };
	const ui = { notify: (text: string, level: string) => notes.push({ text, level }) };
	const signal = new AbortController().signal;
	const ctxFor = (cwd: string) => ({ cwd, ui, signal, isIdle: () => { if (state.stale) throw new Error("stale runtime"); return state.idle; }, sessionManager: { getSessionId: () => sessionId, getEntries: () => entries } });
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		on: (event: string, fn: any) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
		sendMessage: (message: any, options: any) => {
			sent.push({ message, options });
			if (throwOnSend) throw new Error("sendMessage failed: session gone");
			if (state.startRunOnSend) state.idle = false;
		},
	};
	return {
		pi,
		tools,
		commands,
		sent,
		notes,
		state,
		ctx: ctxFor,
		emit: async (event: string, payload: unknown = {}) => {
			let result: unknown;
			for (const fn of handlers.get(event) ?? []) result = (await fn(payload, ctxFor("/"))) ?? result;
			return result;
		},
		call: (name: string, params: unknown, cwd: string) => tools.get(name).execute("call-1", params, undefined, undefined, ctxFor(cwd)),
	};
}

function setup(
	t: Parameters<typeof tempDir>[0],
	opts: Parameters<typeof createJobsExtension>[0] = {},
	{ production = false, throwOnSend = false } = {},
) {
	const dir = tempDir(t);
	const fake = fakePi(throwOnSend);
	// production: only the log root is set, exactly as the default export configures limits.
	let mgr: JobManager | undefined;
	const onManager = (m: JobManager) => (mgr = m);
	const options = production
		? { logRoot: join(dir, "logs"), onManager }
		: { logRoot: join(dir, "logs"), killGraceMs: 300, drainMs: 300, minIntervalSeconds: 0.1, onManager, ...opts };
	createJobsExtension(options)(fake.pi as any);
	t.after(() => fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }));
	return { dir, ...fake, manager: () => mgr };
}

test("default export is an extension factory", () => {
	assert.equal(typeof defaultExtension, "function");
});

test("registers the five tools and /jobs, with no-poll guidance", t => {
	const { tools, commands } = setup(t);
	assert.deepEqual([...tools.keys()], ["job_start", "job_watch", "job_list", "job_output", "job_kill"]);
	assert.ok(commands.has("jobs"));
	for (const name of ["job_start", "job_watch"]) assert.match(tools.get(name).description, /End your turn.*woken.*Do not poll/s);
	for (const tool of tools.values()) assert.equal(tool.parameters.type, "object");
	// CI guidance: watch an immutable target, not a PR number.
	assert.match(tools.get("job_start").description, /gh run watch <run-id> --exit-status/);
	assert.match(tools.get("job_start").description, /commit SHA.*not a PR number/s);
});

test("job_start → completion message wakes the agent exactly once", async t => {
	const { dir, call, sent } = setup(t);
	const res = await call("job_start", { command: "printf 'a\\nb\\n'; exit 4", timeoutSeconds: 10, label: "demo" }, dir);
	assert.match(res.content[0].text, /^Started job j1 \(demo\), timeout 10s\.\nlog: .*j1\.log\nEnd your turn now/);
	assert.equal(res.details.status, "running");
	await waitUntil(() => sent.length === 1, 5000, "notification");
	await sleep(150);
	assert.equal(sent.length, 1);
	const { message, options } = sent[0];
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal(message.customType, CUSTOM_TYPE);
	assert.equal(message.display, true);
	assert.match(message.content[0].text, /^Job j1 failed: demo\nexit 4 · after \d+s\ncommand: printf .*\nlog: .*\noutput:\na\nb$/);
	assert.equal(message.details.completions[0].job.exitCode, 4);
	assert.match(message.details.completions[0].completionId, /^[0-9a-f-]{36}$/);
	assert.equal(typeof message.details.deliveryId, "string");
});

test("job_watch → matched notification with the last check output", async t => {
	const { dir, call, sent } = setup(t);
	setTimeout(() => writeFileSync(join(dir, "ready"), "built\n"), 300);
	const res = await call("job_watch", { check: "cat ready", intervalSeconds: 0.1, timeoutSeconds: 5 }, dir);
	assert.match(res.content[0].text, /^Started watch j1 .* until success/);
	await waitUntil(() => sent.length === 1, 5000, "notification");
	const text = sent[0].message.content[0].text;
	assert.match(text, /^Watch j1 matched: cat ready\nuntil success · \d+ checks · last check exit 0 · after/);
	assert.match(text, /last check output:\nbuilt$/);
	assert.equal(sent[0].message.details.completions[0].job.lastCheck.output, ""); // bulky output kept out of details
});

test("validation errors are thrown as tool failures", async t => {
	const { dir, call } = setup(t);
	await assert.rejects(call("job_start", { command: "true", timeoutSeconds: 99999 }, dir), /timeoutSeconds must be between 1 and 14400/);
	await assert.rejects(call("job_start", { command: "  ", timeoutSeconds: 5 }, dir), /command must be a non-empty string/);
	await assert.rejects(call("job_start", { command: "true", timeoutSeconds: 5, cwd: "missing" }, dir), /cwd is not an existing directory/);
	await assert.rejects(call("job_watch", { check: "true", intervalSeconds: 5, timeoutSeconds: 60, until: "sometimes" }, dir), /until must be/);
	await assert.rejects(call("job_output", { id: "j42" }, dir), /No job with id j42/);
});

test("production interval floor is 10 s", async t => {
	const { dir, call } = setup(t, { minIntervalSeconds: undefined });
	await assert.rejects(call("job_watch", { check: "true", intervalSeconds: 2, timeoutSeconds: 60 }, dir), /intervalSeconds must be between 10 and 3600/);
});

test("relative cwd resolves against the session cwd", async t => {
	const { dir, call, sent } = setup(t);
	const { mkdirSync } = await import("node:fs");
	mkdirSync(join(dir, "sub"));
	await call("job_start", { command: "pwd", timeoutSeconds: 5, cwd: "sub" }, dir);
	await waitUntil(() => sent.length === 1);
	assert.match(sent[0].message.content[0].text, /output:\n.*\/sub$/);
});

test("job_list, job_output and job_kill", async t => {
	const { dir, call, sent } = setup(t);
	await call("job_start", { command: "echo started; sleep 100 & echo $! > gc.pid; sleep 100", timeoutSeconds: 60, label: "long" }, dir);
	await waitUntil(() => existsSync(join(dir, "gc.pid")));
	const list = await call("job_list", {}, dir);
	assert.match(list.content[0].text, /^Running \(1\):\n  j1 · job · running · \d+s — long$/);
	const out = await call("job_output", { id: "j1", tailLines: 5 }, dir);
	assert.match(out.content[0].text, /log: .*\noutput:\nstarted$/);
	const killed = await call("job_kill", { id: "j1" }, dir);
	assert.match(killed.content[0].text, /^Stopped: j1 · job · killed · exit 143 \(likely SIGTERM\)/);
	await waitUntil(() => !alive(readPid(join(dir, "gc.pid"))), 3000, "grandchild to die");
	const again = await call("job_kill", { id: "j1" }, dir);
	assert.match(again.content[0].text, /^Already finished: /);
	await sleep(200);
	assert.equal(sent.length, 0, "job_kill must not notify");
});

test("concurrency cap surfaces as a tool error", async t => {
	const { dir, call } = setup(t, { maxRunning: 1 });
	await call("job_start", { command: "sleep 100", timeoutSeconds: 60 }, dir);
	await assert.rejects(call("job_start", { command: "true", timeoutSeconds: 5 }, dir), /Too many running background jobs \(1\/1\)/);
});

test("/jobs command lists and kills", async t => {
	const { dir, call, commands, ctx, notes } = setup(t);
	await call("job_start", { command: "sleep 100", timeoutSeconds: 60 }, dir);
	await commands.get("jobs").handler("", ctx(dir));
	assert.match(notes[0].text, /Running \(1\):\n  j1 · job · running/);
	await commands.get("jobs").handler("kill j1", ctx(dir));
	assert.match(notes[1].text, /^Stopped: j1 · job · killed/);
	await commands.get("jobs").handler("kill", ctx(dir));
	assert.equal(notes[2].level, "warning");
});

test("session_shutdown kills running jobs without notifying", async t => {
	const { dir, call, sent, emit } = setup(t);
	await call("job_start", { command: "sleep 100 & echo $! > gc.pid; sleep 100", timeoutSeconds: 60 }, dir);
	await call("job_watch", { check: "sleep 100", intervalSeconds: 1, timeoutSeconds: 60 }, dir);
	await waitUntil(() => existsSync(join(dir, "gc.pid")));
	const gc = readPid(join(dir, "gc.pid"));
	await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	await waitUntil(() => !alive(gc), 3000, "grandchild to die");
	await sleep(200);
	assert.equal(sent.length, 0);
	await assert.rejects(call("job_start", { command: "true", timeoutSeconds: 5 }, dir), /shutting down/);
});

test("pi exiting without session_shutdown kills job groups; >10 instances add exactly one exit listener", async t => {
	const dir = tempDir(t);
	const ext = new URL("../src/extension.ts", import.meta.url).href;
	const script = `
		import { createJobsExtension } from ${JSON.stringify(ext)};
		import { existsSync } from "node:fs";
		const before = process.listenerCount("exit");
		const all = [];
		for (let i = 0; i < 12; i++) {
			const tools = new Map();
			const pi = { registerTool: t => tools.set(t.name, t), registerCommand() {}, on() {}, sendMessage() {} };
			createJobsExtension({ logRoot: ${JSON.stringify(join(dir, "logs"))} })(pi);
			all.push(tools);
		}
		for (let i = 0; i < all.length; i++)
			await all[i].get("job_start").execute("x", { command: "sleep 100 & echo $! > gc-" + i + ".pid; sleep 100", timeoutSeconds: 60 }, undefined, undefined, { cwd: ${JSON.stringify(dir)} });
		for (let i = 0; i < all.length; i++)
			while (!existsSync(${JSON.stringify(dir)} + "/gc-" + i + ".pid")) await new Promise(r => setTimeout(r, 20));
		console.log("delta=" + (process.listenerCount("exit") - before));
		process.exit(0);`;
	const { spawnSync } = await import("node:child_process");
	const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 });
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stdout.trim(), "delta=1");
	assert.doesNotMatch(res.stderr, /MaxListeners/);
	const pids = Array.from({ length: 12 }, (_, i) => readPid(join(dir, `gc-${i}.pid`)));
	await waitUntil(() => pids.every(p => !alive(p)), 3000, "all grandchildren to die after host exit");
});

test("host exit while a finished job's TERM-ignoring descendant awaits escalation kills it at once", async t => {
	const dir = tempDir(t);
	const ext = new URL("../src/extension.ts", import.meta.url).href;
	const script = `
		import { createJobsExtension } from ${JSON.stringify(ext)};
		import { existsSync } from "node:fs";
		const tools = new Map();
		let manager;
		const pi = { registerTool: t => tools.set(t.name, t), registerCommand() {}, on() {}, sendMessage() {} };
		createJobsExtension({ logRoot: ${JSON.stringify(join(dir, "logs"))}, onManager: m => (manager = m) })(pi); // default 5 s grace
		await tools.get("job_start").execute("x", { command: "trap '' TERM; sleep 30 & echo $! > d.pid", timeoutSeconds: 60 }, undefined, undefined, { cwd: ${JSON.stringify(dir)} });
		while (manager.get("j1").status === "running") await new Promise(r => setTimeout(r, 20));
		if (!manager.ownsProcesses) { console.log("not-owned"); process.exit(3); }
		process.exit(0);`;
	const { spawnSync } = await import("node:child_process");
	const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 });
	assert.equal(res.status, 0, res.stdout + res.stderr);
	const d = readPid(join(dir, "d.pid"));
	await waitUntil(() => !alive(d), 1500, "descendant to be killed by the exit hook, well before the 5 s grace");
});

test("production defaults through the adapter: 8-job cap and 5000 ms kill grace", async t => {
	const { dir, call } = setup(t, {}, { production: true });
	for (let i = 0; i < 8; i++) await call("job_start", { command: "sleep 100 # prod-defaults", timeoutSeconds: 60 }, dir);
	await assert.rejects(call("job_start", { command: "true", timeoutSeconds: 5 }, dir), /Too many running background jobs \(8\/8\)/);
	const ours = [...liveManagers()].find(m => m.list().some(j => j.command.includes("prod-defaults")));
	assert.ok(ours, "manager owning running jobs must be in the exit-hook set");
	assert.equal(ours.opts.killGraceMs, 5000);
	assert.equal(ours.opts.maxRunning, 8);
	assert.equal(ours.opts.maxRunningWatches, 32);
});

test("manager stays in the exit-hook set until shutdown has finished", async t => {
	const { dir, call, emit } = setup(t);
	await call("job_start", { command: "trap '' TERM; sleep 100 & echo $! > gc.pid; sleep 100 # stays-live", timeoutSeconds: 60 }, dir);
	await waitUntil(() => existsSync(join(dir, "gc.pid")));
	const gc = readPid(join(dir, "gc.pid"));
	const live = liveManagers();
	const ours = [...live].find(m => m.list().some(j => j.command.includes("stays-live")))!;
	assert.ok(ours);
	const shutdown = emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	assert.ok(live.has(ours), "removed from the exit-hook set before shutdown completed");
	await shutdown;
	assert.ok(!live.has(ours));
	await waitUntil(() => !alive(gc), 3000, "TERM-ignoring grandchild to be SIGKILLed");
});

test("a session disposed without session_shutdown leaves the exit-hook set when its jobs end", async t => {
	const live = liveManagers();
	const before = live.size;
	const { dir, call, sent } = setup(t);
	assert.equal(live.size, before, "idle manager must not be registered");
	await call("job_start", { command: "sleep 0.2", timeoutSeconds: 10 }, dir);
	assert.equal(live.size, before + 1, "manager with a running job must be registered");
	await waitUntil(() => sent.length === 1);
	await waitUntil(() => live.size === before, 2000, "manager to leave the set");
});

test("stale context (sendMessage throws): no retries; the loss is reported once", async t => {
	const { dir, call, sent, notes, manager } = setup(t, {}, { throwOnSend: true });
	await call("job_start", { command: "exit 2", timeoutSeconds: 10 }, dir);
	await waitUntil(() => sent.length === 1, 5000, "send attempt");
	await call("job_start", { command: "true", timeoutSeconds: 10 }, dir);
	// The second completion has been handed to the (disposed) delivery once j2 is terminal.
	await waitUntil(() => manager()!.get("j2")?.status === "succeeded", 5000, "second job terminal");
	assert.equal(sent.length, 1, "nothing is retried or sent after a stale context");
	assert.equal(notes.filter(n => /was not delivered/.test(n.text)).length, 1);
	const list = await call("job_list", {}, dir);
	assert.match(list.content[0].text, /j1 · job · failed · exit 2/);
});

const ourMessageEnd = (details: unknown) => ({ type: "message_end", message: { role: "custom", customType: CUSTOM_TYPE, details } });

test("completions during a run are held and sent as ONE follow-up at agent_end", async t => {
	const { dir, call, sent, state, emit, manager } = setup(t);
	state.idle = false;
	await emit("agent_start", { type: "agent_start" });
	await call("job_start", { command: "echo held", timeoutSeconds: 10 }, dir);
	await call("job_start", { command: "echo held-too", timeoutSeconds: 10 }, dir);
	await waitUntil(() => manager()!.list().every(j => j.status !== "running"), 5000, "both jobs");
	await sleep(200);
	assert.equal(sent.length, 0, "must not send while a run is active");
	await emit("agent_end", { type: "agent_end", messages: [] });
	assert.equal(sent.length, 1);
	const { message, options } = sent[0];
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
	assert.deepEqual(message.details.completions.map((c: any) => c.job.id).sort(), ["j1", "j2"]);
	assert.match(message.content[0].text, /^2 background jobs finished:/);
	await emit("message_end", ourMessageEnd(message.details));
	state.idle = true;
	await emit("agent_settled", { type: "agent_settled" });
	assert.equal(sent.length, 1, "a confirmed delivery is never repeated");
});

test("a follow-up dropped before confirmation (Escape) is resent once at agent_settled", async t => {
	const { dir, call, sent, state, emit, manager } = setup(t);
	state.idle = false;
	await emit("agent_start", { type: "agent_start" });
	await call("job_start", { command: "echo lost-once", timeoutSeconds: 10 }, dir);
	await waitUntil(() => manager()!.get("j1")?.status === "succeeded", 5000, "job");
	await emit("agent_end", { type: "agent_end", messages: [] });
	assert.equal(sent.length, 1);
	state.idle = true;
	await emit("agent_settled", { type: "agent_settled" }); // no message_end: pi dropped it
	assert.equal(sent.length, 2);
	assert.deepEqual(sent[1].message.details.completions, sent[0].message.details.completions, "same completion id");
	await emit("agent_settled", { type: "agent_settled" });
	assert.equal(sent.length, 2, "at most one resend");
});

for (const event of ["session_compact", "session_tree"]) {
	test(`busy without a run: held, then sent after ${event}`, async t => {
		const { dir, call, sent, state, emit, manager } = setup(t);
		state.idle = false; // compacting / summarizing a branch: no agent_start, but not idle
		await call("job_start", { command: "echo busy", timeoutSeconds: 10 }, dir);
		await waitUntil(() => manager()!.get("j1")?.status === "succeeded", 5000, "job");
		assert.equal(sent.length, 0, "must not start a run while pi is busy");
		state.idle = true;
		await emit(event, { type: event });
		assert.equal(sent.length, 0, "the event fires before pi clears its busy state: drain on the next turn of the event loop");
		await new Promise(r => setImmediate(r));
		assert.equal(sent.length, 1);
	});
}

test("batch output budget is shared: 20 completions stay within 16 KB of output", async t => {
	const { dir, call, sent, state, emit, manager } = setup(t, { maxRunning: 20 });
	state.idle = false;
	await emit("agent_start", { type: "agent_start" });
	for (let i = 0; i < 20; i++) await call("job_start", { command: "head -c 3000 /dev/zero | tr '\\0' x", timeoutSeconds: 10 }, dir);
	await waitUntil(() => manager()!.list().every(j => j.status !== "running"), 10_000, "all jobs");
	await emit("agent_end", { type: "agent_end", messages: [] });
	assert.equal(sent.length, 1);
	const text = sent[0].message.content.map((p: any) => p.text).join("");
	assert.match(text, /^20 background jobs finished:/);
	const outputBytes = (text.match(/x{5,}/g) ?? []).reduce((n, run) => n + run.length, 0);
	assert.ok(outputBytes > 0 && outputBytes <= 16 * 1024, `output bytes ${outputBytes}`);
});

test("context handler: a whole repeat of a completion id is stubbed; a new j1 is not", async t => {
	const { emit } = setup(t);
	const msg = (deliveryId: string, completionId: string) => ({
		role: "custom",
		customType: CUSTOM_TYPE,
		content: [{ type: "text", text: completionId }],
		details: { deliveryId, completions: [{ completionId, job: { id: "j1" } }] },
	});
	const user = { role: "user", content: "hi" };
	const res: any = await emit("context", { type: "context", messages: [user, msg("a", "c1"), msg("b", "c1"), msg("c", "c2")] });
	assert.deepEqual(
		res.messages.map((m: any) => m.content?.[0]?.text ?? "user"),
		["user", "c1", "[pi-jobs: this completion was already delivered above; nothing new.]", "c2"],
	);
	assert.equal(await emit("context", { type: "context", messages: [user, msg("a", "c1"), msg("b", "c2")] }), undefined);
});

test("each extension instance (e.g. a subagent session) owns its jobs", async t => {
	const a = setup(t);
	const b = setup(t);
	await a.call("job_start", { command: "sleep 100", timeoutSeconds: 60 }, a.dir);
	await b.call("job_start", { command: "true", timeoutSeconds: 60 }, b.dir);
	await waitUntil(() => b.sent.length === 1);
	assert.equal(a.sent.length, 0);
	await b.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	const list = await a.call("job_list", {}, a.dir);
	assert.match(list.content[0].text, /j1 · job · running/);
});

const RUNTIME = runtimeDirectory();
const PI_AI = piAiEntry(RUNTIME);

test("tool schemas enforce the bounds through pi's own argument validation", { skip: PI_AI && existsSync(PI_AI) ? false : "pi-ai not found; install the pi runtime or set PI_RUNTIME_DIR" }, async t => {
	const { validateToolArguments } = await import(PI_AI!);
	const { tools } = setup(t, {}, { production: true });
	const ok = (name: string, args: object) => validateToolArguments(tools.get(name), { type: "toolCall", id: "x", name, arguments: args });
	const bad = (name: string, args: object) => assert.throws(() => ok(name, args), undefined, `${name} ${JSON.stringify(args)} must be rejected`);
	ok("job_start", { command: "true", timeoutSeconds: 14400 });
	bad("job_start", { command: "true", timeoutSeconds: 0 });
	bad("job_start", { command: "true", timeoutSeconds: 14401 });
	bad("job_start", { command: "", timeoutSeconds: 5 });
	ok("job_watch", { check: "true", intervalSeconds: 10, timeoutSeconds: 60, checkTimeoutSeconds: 30 });
	bad("job_watch", { check: "true", intervalSeconds: 9, timeoutSeconds: 60 });
	bad("job_watch", { check: "true", intervalSeconds: 3601, timeoutSeconds: 60 });
	bad("job_watch", { check: "true", intervalSeconds: 10, timeoutSeconds: 60, checkTimeoutSeconds: 0 });
	bad("job_watch", { check: "true", intervalSeconds: 10, timeoutSeconds: 60, until: "sometimes" });
	ok("job_output", { id: "j1", tailLines: 200 });
	bad("job_output", { id: "j1", tailLines: 2.5 });
	bad("job_output", { id: "j1", tailLines: 201 });
	bad("job_output", { id: "j1", tailLines: 0 });
	assert.match(tools.get("job_watch").parameters.properties.checkTimeoutSeconds.description, /Default: min\(120, timeoutSeconds\)/);
});


test("reload adopts a running command and watch, preserves ids and delivers through the new API", async t => {
	const dir = tempDir(t);
	const id = randomUUID();
	const old = fakePi(false, id);
	const next = fakePi(false, id);
	const options = { logRoot: join(dir, "logs"), killGraceMs: 50, drainMs: 50, minIntervalSeconds: 0.05 };
	createJobsExtension(options)(old.pi as any);
	await old.emit("session_start", { reason: "startup" });
	t.after(() => next.emit("session_shutdown", { reason: "quit" }));
	const command = await old.call("job_start", { command: "while [ ! -f done ]; do sleep 0.02; done; echo completed", timeoutSeconds: 10 }, dir);
	const watch = await old.call("job_watch", { check: "test -f ready", intervalSeconds: 0.05, timeoutSeconds: 10 }, dir);
	await old.emit("session_shutdown", { reason: "reload" });
	writeFileSync(join(dir, "done"), "");
	await sleep(150); // completion during the reload gap must be buffered
	assert.equal(old.sent.length, 0);
	createJobsExtension(options)(next.pi as any);
	next.pi.on("session_start", () => assert.equal(next.sent.length, 0, "later extension initializes before triggerTurn"));
	await next.emit("session_start", { reason: "reload" });
	const listed = await next.call("job_list", {}, dir);
	assert.deepEqual(listed.details.jobs.map((j: any) => j.id).sort(), [command.details.id, watch.details.id].sort());
	writeFileSync(join(dir, "ready"), "");
	await waitUntil(() => next.sent.flatMap(s => s.message.details.completions).length === 2);
	assert.deepEqual(next.sent.flatMap(s => s.message.details.completions).map((c: any) => c.job.status).sort(), ["matched", "succeeded"]);
	assert.equal(old.sent.length, 0);
	const third = await next.call("job_start", { command: "sleep 1", timeoutSeconds: 5 }, dir);
	assert.equal(third.details.id, "j3");
	assert.match(next.notes[0].text, /re-adopted/);
});

test("reload keeps a watch's original deadline and change baseline", async t => {
	const dir = tempDir(t), id = randomUUID();
	const old = fakePi(false, id), next = fakePi(false, id);
	const options = { logRoot: join(dir, "logs"), killGraceMs: 50, drainMs: 50, minIntervalSeconds: 0.05 };
	createJobsExtension(options)(old.pi as any);
	await old.emit("session_start", { reason: "startup" });
	await old.call("job_watch", { check: "echo unchanged", until: "change", intervalSeconds: 0.05, timeoutSeconds: 1 }, dir);
	await sleep(650);
	await old.emit("session_shutdown", { reason: "reload" });
	createJobsExtension(options)(next.pi as any);
	t.after(() => next.emit("session_shutdown", { reason: "quit" }));
	await next.emit("session_start", { reason: "reload" });
	await waitUntil(() => next.sent.length === 1, 800, "original watch deadline");
	assert.equal(next.sent[0].message.details.completions[0].job.status, "timed_out");
});

test("a legacy upgrade that stops work without a handoff reports every full command in model context", async t => {
	const dir = tempDir(t), id = randomUUID();
	const entries: any[] = [];
	const old = fakePi(false, id, entries), next = fakePi(false, id, entries);
	const manager = new JobManager({ logRoot: join(dir, "logs"), killGraceMs: 50, drainMs: 50, onTerminal: () => {} });
	t.after(() => manager.shutdown());
	// The pre-0.2 extension's shutdown handler ignored the reason (4011ae7:252-260).
	// Its manager was never registered in sessionOwners, so new code cannot resurrect it.
	old.pi.on("session_shutdown", async () => manager.shutdown());
	const command = manager.start({ command: "while [ ! -f done ]; do sleep 0.02; done", cwd: dir, timeoutSeconds: 10 });
	const watch = manager.watch({ check: `echo '${"full command ".repeat(100)}'; false`, cwd: dir, intervalSeconds: 0.05, timeoutSeconds: 10, checkTimeoutSeconds: 1, until: "success" });
	for (const job of [command, watch]) entries.push({ type: "message", message: { role: "toolResult", toolName: job.kind === "watch" ? "job_watch" : "job_start", details: job } });
	await old.emit("session_shutdown", { reason: "reload" });
	assert.equal(manager.get(command.id)?.status, "killed");
	assert.equal(manager.get(watch.id)?.status, "killed");
	assert.equal(sessionOwners().has(id), false);
	createJobsExtension({ logRoot: join(dir, "logs") })(next.pi as any);
	t.after(() => next.emit("session_shutdown", { reason: "quit" }));
	await next.emit("session_start", { reason: "reload" });
	assert.deepEqual((await next.call("job_list", {}, dir)).details.jobs, []);
	assert.equal(next.sent.length, 2);
	for (const [i, job] of [command, watch].entries()) {
		const notice = next.sent[i];
		assert.equal(notice.message.customType, "pi-jobs-reload");
		assert.equal(notice.message.display, true);
		assert.equal(notice.options.triggerTurn, false);
		assert.ok(String(notice.message.content).includes(`command: ${job.command}\n`));
		assert.ok(next.notes.some(note => note.text.includes(job.command) && note.text.includes(job.cwd) && note.text.includes(job.logPath)));
		assert.equal(notice.message.details.unadopted.id, job.id);
	}
});

test("incompatible handoff reports running items before stopping them", async t => {
	const dir = tempDir(t), id = randomUUID();
	const old = fakePi(false, id), next = fakePi(false, id);
	const options = { logRoot: join(dir, "logs"), killGraceMs: 50, minIntervalSeconds: 0.05 };
	createJobsExtension(options)(old.pi as any);
	await old.emit("session_start", { reason: "startup" });
	const watch = await old.call("job_watch", { check: "echo incompatible; false", intervalSeconds: 0.05, timeoutSeconds: 10 }, dir);
	await old.emit("session_shutdown", { reason: "reload" });
	const owner = sessionOwners().get(id)!;
	(owner as any).version = 999;
	createJobsExtension(options)(next.pi as any);
	t.after(() => next.emit("session_shutdown", { reason: "quit" }));
	await next.emit("session_start", { reason: "reload" });
	assert.equal(owner.manager.get(watch.details.id)?.status, "killed");
	assert.equal(next.sent.length, 1);
	assert.ok(String(next.sent[0].message.content).includes(watch.details.command));
});

test("a replacement module adopts compatible older snapshots without intervalSeconds", async t => {
	const dir = tempDir(t), id = randomUUID();
	const old = fakePi(false, id), next = fakePi(false, id);
	const options = { logRoot: join(dir, "logs"), killGraceMs: 50, drainMs: 50, minIntervalSeconds: 0.05 };
	createJobsExtension(options)(old.pi as any);
	await old.emit("session_start", { reason: "startup" });
	const command = await old.call("job_start", { command: "while [ ! -f done ]; do sleep 0.02; done", timeoutSeconds: 10 }, dir);
	const watch = await old.call("job_watch", { check: "test -f ready", intervalSeconds: 0.05, timeoutSeconds: 10 }, dir);
	const manager = sessionOwners().get(id)!.manager;
	const list = manager.list.bind(manager);
	manager.list = () => list().map(({ intervalSeconds, ...snapshot }) => snapshot);
	await old.emit("session_shutdown", { reason: "reload" });
	const replacement = await import(`../src/extension.ts?replacement=${randomUUID()}`);
	replacement.createJobsExtension(options)(next.pi as any);
	t.after(() => next.emit("session_shutdown", { reason: "quit" }));
	await next.emit("session_start", { reason: "reload" });
	assert.equal(sessionOwners().get(id)!.manager, manager);
	assert.deepEqual((await next.call("job_list", {}, dir)).details.jobs.map((job: any) => job.id), [command.details.id, watch.details.id]);
	assert.equal(next.sent.length, 0);
	writeFileSync(join(dir, "done"), "");
	writeFileSync(join(dir, "ready"), "");
	await waitUntil(() => next.sent.flatMap(message => message.message.details.completions).length === 2);
	assert.equal(old.sent.length, 0);
	assert.deepEqual(next.sent.flatMap(message => message.message.details.completions).map(completion => completion.job.status).sort(), ["matched", "succeeded"]);
});

test("history continues numbering when no manager can be adopted", async t => {
	const dir = tempDir(t);
	const fake = fakePi(false, randomUUID(), [
		{ type: "message", message: { role: "toolResult", toolName: "job_start", details: { id: "j544" } } },
	]);
	createJobsExtension({ logRoot: join(dir, "logs"), killGraceMs: 50 })(fake.pi as any);
	t.after(() => fake.emit("session_shutdown", { reason: "quit" }));
	await fake.emit("session_start", { reason: "reload" });
	const result = await fake.call("job_start", { command: "sleep 1", timeoutSeconds: 5 }, dir);
	assert.equal(result.details.id, "j545");
});


test("session_start reports and stops proven orphan watches, not another live session", async t => {
	const dir = tempDir(t);
	const old = fakePi(), live = fakePi(), next = fakePi();
	const options = { logRoot: join(dir, "logs"), killGraceMs: 50, drainMs: 50, minIntervalSeconds: 0.05 };
	for (const fake of [old, live, next]) {
		createJobsExtension(options)(fake.pi as any);
		t.after(() => fake.emit("session_shutdown", { reason: "quit" }));
	}
	await old.emit("session_start", { reason: "startup" });
	await live.emit("session_start", { reason: "startup" });
	await old.call("job_watch", { check: "sleep 30", intervalSeconds: 0.05, timeoutSeconds: 60 }, dir);
	await live.call("job_watch", { check: "false", intervalSeconds: 0.05, timeoutSeconds: 60 }, dir);
	old.state.stale = true; // runtime invalidated without a shutdown handler
	await next.emit("session_start", { reason: "reload" });
	assert.match(next.notes[0].text, /owner session .* is gone; stopped orphaned watch j1.*log:/);
	assert.equal((await old.call("job_list", {}, dir)).details.jobs[0].status, "killed");
	assert.equal((await live.call("job_list", {}, dir)).details.jobs[0].status, "running");
});
