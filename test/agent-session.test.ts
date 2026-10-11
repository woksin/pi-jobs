/**
 * Delivery against the real pi AgentSession (installed runtime) with the faux model provider.
 * Skipped when no installed runtime can be resolved (override: PI_RUNTIME_DIR).
 * Two tests reproduce pi-side races and are skipped with a pointer to UPSTREAM-ISSUES.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobsExtension, CUSTOM_TYPE } from "../src/extension.ts";
import type { JobManager } from "../src/jobs.ts";
import { sleep, tempDir, waitUntil } from "./helpers.ts";
import { piAiEntry, runtimeDirectory } from "./runtime.ts";

const RUNTIME = runtimeDirectory();
const available = RUNTIME !== undefined && existsSync(join(RUNTIME, "dist/index.js"));
const skip = available ? false : "pi runtime not found; install @earendil-works/pi-coding-agent or set PI_RUNTIME_DIR";
const upstream = (n: number, what: string) => (available ? `pi-side race, see UPSTREAM-ISSUES.md #${n}: ${what}` : skip);

let providerSeq = 0;

interface HarnessOptions {
	/** Extra extension, loaded after pi-jobs (so its handlers run after ours). */
	extra?: (pi: any) => void;
	/** Extra extension, loaded before pi-jobs (so its handlers run before ours). */
	before?: (pi: any) => void;
	/** Prepare the session history before the session starts (resume/fork). */
	history?: (sessionManager: any) => void;
}

async function harness(t: Parameters<typeof tempDir>[0], opts: HarnessOptions = {}) {
	const pc: any = await import(join(RUNTIME!, "dist/index.js"));
	const ai: any = await import(piAiEntry(RUNTIME)!);
	const dir = tempDir(t);
	const agentDir = join(dir, "agent");
	const faux = ai.fauxProvider({ provider: `pijobs-faux-${process.pid}-${++providerSeq}`, models: [{ id: "m1" }] });
	const modelRuntime = await pc.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = pc.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
	let manager!: JobManager;
	/** Model contexts after all `context` handlers (what the model actually sees). */
	const contexts: any[][] = [];
	const recorder = (pi: any) => pi.on("context", async (e: any) => void contexts.push(e.messages));
	const ext = createJobsExtension({ logRoot: join(dir, "logs"), killGraceMs: 300, drainMs: 200, onManager: m => (manager = m) });
	const resourceLoader = new pc.DefaultResourceLoader({
		cwd: dir,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		noExtensions: true,
		extensionFactories: [...(opts.before ? [opts.before] : []), ext, ...(opts.extra ? [opts.extra] : []), recorder],
	});
	await resourceLoader.reload();
	const sessionManager = pc.SessionManager.inMemory(dir);
	opts.history?.(sessionManager);
	const { session } = await pc.createAgentSession({
		cwd: dir,
		agentDir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		noTools: "builtin",
		sessionManager,
		settingsManager,
	});
	t.after(async () => {
		try {
			await session.abort();
		} catch {}
		session.dispose();
		await manager?.shutdown(200);
	});
	const completions = () => session.messages.filter((m: any) => m.role === "custom" && m.customType === CUSTOM_TYPE);
	const assistantTexts = () =>
		session.messages.filter((m: any) => m.role === "assistant").map((m: any) => m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""));
	/** Most completion messages showing `marker` in any one model context so far. */
	const maxSeen = (marker: string) =>
		Math.max(
			0,
			...contexts.map(c => c.filter((m: any) => m.role === "custom" && m.customType === CUSTOM_TYPE && JSON.stringify(m.content).includes(marker)).length),
		);
	/**
	 * A model response that blocks until released or aborted (a long streaming turn).
	 * `entered` resolves once pi is inside it, i.e. the turn is provably streaming.
	 */
	const blocking = () => {
		let release!: () => void;
		let markEntered!: () => void;
		const entered = new Promise<void>(r => (markEntered = r));
		const step = (_ctx: unknown, options: { signal?: AbortSignal } | undefined) =>
			new Promise(resolve => {
				release = () => resolve(ai.fauxAssistantMessage("busy done"));
				options?.signal?.addEventListener("abort", () => resolve(ai.fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
				markEntered();
			});
		return { step, entered, release: () => release() };
	};
	const reply = (text: string) => () => ai.fauxAssistantMessage(text);
	const startJob = (command: string) => ai.fauxAssistantMessage([ai.fauxToolCall("job_start", { command, timeoutSeconds: 20 })], { stopReason: "toolUse" });
	/** A job command that finishes only once the test touches `name` in the session dir. */
	const gated = (name: string, marker: string) => `while [ ! -f ${name} ]; do sleep 0.05; done; echo ${marker}`;
	const open = (name: string) => writeFileSync(join(dir, name), "");
	return { session, faux, ai, dir, manager: () => manager, completions, assistantTexts, maxSeen, blocking, reply, startJob, gated, open };
}

async function idle(session: any, ms = 5000) {
	await waitUntil(() => session.isIdle, ms, "session idle");
}

for (const [name, escape] of [
	["Escape (clearQueue + abort)", true],
	["RPC abort", false],
] as const) {
	test(`completion during a streaming turn survives ${name}: delivered once, seen once`, { skip }, async t => {
		const h = await harness(t);
		const busy = h.blocking();
		h.faux.setResponses([h.startJob(h.gated("go", "ESC-DONE")), busy.step, ...[1, 2, 3].map(() => h.reply("woken"))]);
		const run = h.session.prompt("go");
		await busy.entered;
		h.open("go");
		await waitUntil(() => h.manager().get("j1")?.status === "succeeded", 5000, "job to finish while the turn streams");
		if (escape) h.session.clearQueue();
		await h.session.abort();
		await run;
		await waitUntil(() => h.completions().length === 1 && h.assistantTexts().includes("woken"), 5000, "delivery after abort");
		await idle(h.session);
		await sleep(300);
		assert.equal(h.completions().length, 1);
		assert.equal(h.maxSeen("ESC-DONE"), 1);
	});
}

test("a follow-up dropped by clearQueue right after we queued it is resent once", { skip }, async t => {
	let session: any;
	let armed = false;
	// Runs after pi-jobs' agent_end handler, i.e. right after the follow-up was queued: Escape.
	const escapeAfterQueue = (pi: any) =>
		pi.on("agent_end", async () => {
			if (armed) {
				armed = false;
				session.clearQueue();
			}
		});
	const h = await harness(t, { extra: escapeAfterQueue });
	session = h.session;
	const busy = h.blocking();
	h.faux.setResponses([h.startJob(h.gated("go", "DROP-DONE")), busy.step, ...[1, 2, 3].map(() => h.reply("woken"))]);
	const run = h.session.prompt("go");
	await busy.entered;
	h.open("go");
	await waitUntil(() => h.manager().get("j1")?.status === "succeeded", 5000, "job");
	armed = true;
	busy.release();
	await run;
	await waitUntil(() => h.completions().length === 1 && h.assistantTexts().includes("woken"), 5000, "resend after the drop");
	await idle(h.session);
	await sleep(300);
	assert.equal(h.completions().length, 1);
	assert.equal(h.maxSeen("DROP-DONE"), 1);
});

test("a follow-up stranded by an abort reappears later but the model sees the completion once", { skip }, async t => {
	let session: any;
	let armed = false;
	// Abort right after pi-jobs queued its follow-up: the copy stays in pi's agent queue.
	const abortAfterQueue = (pi: any) =>
		pi.on("agent_end", async () => {
			if (armed) {
				armed = false;
				void session.abort();
			}
		});
	const h = await harness(t, { extra: abortAfterQueue });
	session = h.session;
	const busy = h.blocking();
	h.faux.setResponses([h.startJob(h.gated("go", "STRANDED-DONE")), busy.step, ...[1, 2, 3, 4, 5].map(() => h.reply("ok"))]);
	const run = h.session.prompt("go");
	await busy.entered;
	h.open("go");
	await waitUntil(() => h.manager().get("j1")?.status === "succeeded", 5000, "job");
	armed = true;
	busy.release();
	await run;
	await idle(h.session);
	await waitUntil(() => h.completions().length >= 1, 5000, "resend");
	await idle(h.session);
	await h.session.prompt("next"); // pi drains the stranded copy at the end of this run
	await idle(h.session);
	assert.ok(h.completions().length >= 1);
	assert.equal(h.maxSeen("STRANDED-DONE"), 1, "the model must never see the same completion twice");
});

test("a completion during manual compaction does not start a run; it is delivered once after", { skip }, async t => {
	const h = await harness(t);
	const summary = h.blocking();
	h.faux.setResponses([
		h.startJob(h.gated("go", "COMPACT-DONE")),
		h.reply("started"),
		summary.step, // the first compaction request blocks
		// Compaction may make one more summarization call; anything else is the wake-up run.
		...[1, 2].map(() => () => h.ai.fauxAssistantMessage(h.session.isCompacting ? "summary" : "woken after compaction")),
	]);
	await h.session.prompt("go");
	const compaction = h.session.compact().catch((e: Error) => e);
	await summary.entered; // compaction is calling the model
	h.open("go"); // the job finishes only now, while compaction is in progress
	await waitUntil(() => h.manager().get("j1")?.status === "succeeded", 5000, "job to finish during compaction");
	assert.equal(h.session.isStreaming, false, "a completion started an agent run during compaction");
	assert.equal(h.completions().length, 0);
	summary.release();
	const result = await compaction;
	assert.ok(!(result instanceof Error), String(result));
	await waitUntil(() => h.completions().length === 1 && h.assistantTexts().includes("woken after compaction"), 5000, "delivery after compaction");
	await idle(h.session);
	await sleep(300);
	assert.equal(h.completions().length, 1);
});

test("completions that finish during one turn arrive as one batched message", { skip }, async t => {
	const h = await harness(t);
	const busy = h.blocking();
	h.faux.setResponses([
		h.ai.fauxAssistantMessage(
			[
				h.ai.fauxToolCall("job_start", { command: "echo BATCH-A", timeoutSeconds: 20 }),
				h.ai.fauxToolCall("job_start", { command: "sleep 0.1; echo BATCH-B", timeoutSeconds: 20 }),
			],
			{ stopReason: "toolUse" },
		),
		busy.step,
		h.reply("woken once"),
	]);
	const run = h.session.prompt("go");
	await busy.entered;
	await waitUntil(() => ["j1", "j2"].every(id => h.manager()?.get(id)?.status === "succeeded"), 5000, "both jobs");
	busy.release();
	await run;
	await waitUntil(() => h.assistantTexts().includes("woken once"), 5000, "wake-up");
	await idle(h.session);
	await sleep(300);
	assert.equal(h.completions().length, 1);
	const text = JSON.stringify(h.completions()[0].content);
	assert.match(text, /2 background jobs finished/);
	assert.match(text, /BATCH-A/);
	assert.match(text, /BATCH-B/);
});

test("resumed history with an older j1 completion does not hide the new j1 from the model", { skip }, async t => {
	const history = (sm: any) => {
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "earlier" }], timestamp: Date.now() });
		// Round-2 format (job handle only) and current format, both for an earlier "j1".
		sm.appendCustomMessageEntry(CUSTOM_TYPE, "Job j1 succeeded: OLD-ONE", true, { deliveryId: "old-1", jobs: [{ id: "j1" }] });
		sm.appendCustomMessageEntry(CUSTOM_TYPE, "Job j1 succeeded: OLD-TWO", true, {
			deliveryId: "old-2",
			completions: [{ completionId: "00000000-0000-4000-8000-000000000000", job: { id: "j1" } }],
		});
	};
	const h = await harness(t, { history });
	h.faux.setResponses([h.startJob("echo NEW-J1"), h.reply("started"), h.reply("woken")]);
	await h.session.prompt("go");
	await waitUntil(() => h.assistantTexts().includes("woken"), 5000, "wake-up");
	await idle(h.session);
	assert.equal(h.maxSeen("NEW-J1"), 1, "the new j1 completion must reach the model");
	assert.equal(h.maxSeen("OLD-ONE"), 1);
	assert.equal(h.maxSeen("OLD-TWO"), 1);
});

test("compaction started by an EARLIER agent_settled handler: the held completion waits for it", { skip }, async t => {
	let compactOnSettle = false;
	// Loaded before pi-jobs: starts a compaction from agent_settled, then yields, so pi is busy
	// again by the time pi-jobs' agent_settled handler runs. The compaction is slowed down.
	const compactor = (pi: any) => {
		pi.on("agent_settled", async (_e: unknown, ctx: any) => {
			if (!compactOnSettle) return;
			compactOnSettle = false;
			ctx.compact();
			await sleep(10);
		});
		pi.on("session_before_compact", async () => {
			await sleep(80);
		});
	};
	const h = await harness(t, { before: compactor });
	const busy = h.blocking();
	let runDuringCompaction = false;
	const probe = () => {
		if (h.session.isCompacting && h.session.isStreaming) runDuringCompaction = true;
		return h.ai.fauxAssistantMessage(h.session.isCompacting ? "summary" : "woken");
	};
	h.faux.setResponses([h.startJob(h.gated("go", "EARLY-DONE")), busy.step, ...[1, 2, 3, 4, 5].map(() => probe)]);
	const run = h.session.prompt("go");
	await busy.entered;
	h.open("go");
	await waitUntil(() => h.manager().get("j1")?.status === "succeeded", 5000, "job (held: a run is active)");
	compactOnSettle = true;
	await h.session.abort(); // aborted run: the held completion is due at agent_settled
	await run;
	await waitUntil(() => h.completions().length === 1 && h.assistantTexts().includes("woken"), 5000, "delivery after the compaction");
	await idle(h.session);
	assert.equal(runDuringCompaction, false, "the completion's run started during compaction");
	assert.equal(h.completions().length, 1);
	assert.equal(h.maxSeen("EARLY-DONE"), 1);
});

test("a completion during branch summarization (/tree) is delivered after session_tree", { skip }, async t => {
	let releaseTree: (() => void) | undefined;
	let markTreeEntered!: () => void;
	const treeEntered = new Promise<void>(r => (markTreeEntered = r));
	const slowTree = (pi: any) =>
		pi.on("session_before_tree", async () => {
			markTreeEntered();
			await new Promise<void>(r => (releaseTree = r));
		});
	const h = await harness(t, { extra: slowTree });
	let runDuringSummary = false;
	const probe = () => {
		if (h.session.isCompacting && h.session.isStreaming) runDuringSummary = true;
		return h.ai.fauxAssistantMessage(h.session.isCompacting ? "branch summary" : "woken");
	};
	h.faux.setResponses([h.startJob(h.gated("go", "TREE-DONE")), h.reply("started"), ...[1, 2, 3, 4].map(() => probe)]);
	await h.session.prompt("go");
	const firstUser = h.session.sessionManager.getEntries().find((e: any) => e.type === "message" && e.message.role === "user");
	const nav = h.session.navigateTree(firstUser.id, { summarize: true });
	await treeEntered; // pi is busy summarizing the branch
	h.open("go");
	await waitUntil(() => h.manager().get("j1")?.status === "succeeded", 5000, "job during the tree navigation");
	assert.equal(h.completions().length, 0);
	releaseTree!();
	const result = await nav;
	assert.equal(result.cancelled, false);
	await waitUntil(() => h.completions().length === 1 && h.assistantTexts().includes("woken"), 5000, "delivery after session_tree");
	await idle(h.session);
	assert.equal(runDuringSummary, false);
	assert.equal(h.maxSeen("TREE-DONE"), 1);
});

test("prompt race: a completion while a prompt is still preparing loses the user's prompt", { skip: upstream(1, "no atomic run reservation") }, async t => {
	let gate!: () => void;
	let armed = false;
	const slowBeforeStart = (pi: any) =>
		pi.on("before_agent_start", async () => {
			if (armed) await new Promise<void>(r => (gate = r));
		});
	const h = await harness(t, { extra: slowBeforeStart });
	const wake = h.blocking(); // the completion's run is still streaming when the prompt continues
	h.faux.setResponses([h.startJob(h.gated("go", "RACE-DONE")), h.reply("started"), wake.step, ...[1, 2, 3].map(() => h.reply("ok"))]);
	await h.session.prompt("go");
	armed = true;
	const user = h.session.prompt("USER-PROMPT").then(() => undefined, (e: Error) => e);
	await waitUntil(() => gate !== undefined, 2000, "prompt preparing");
	h.open("go");
	await waitUntil(() => h.manager().get("j1")?.status === "succeeded", 5000, "job");
	await wake.entered; // the completion's run is streaming
	gate();
	const error = await user;
	wake.release();
	await idle(h.session);
	assert.equal(error, undefined, `user prompt failed: ${error}`);
	assert.ok(JSON.stringify(h.session.messages).includes("USER-PROMPT"), "the user's prompt must not be lost");
});

test("deferred settled action runs during a compaction started by a LATER agent_settled handler", { skip: upstream(2, "deferred actions are not revalidated") }, async t => {
	// Deterministic: one-shot compactor loaded AFTER pi-jobs, history that can be compacted
	// (keepRecentTokens: 1), and a compaction slowed by session_before_compact.
	let compactOnSettle = false;
	let compactionDone!: () => void;
	const compacted = new Promise<void>(r => (compactionDone = r));
	const compactor = (pi: any) => {
		pi.on("agent_settled", async (_e: unknown, ctx: any) => {
			if (!compactOnSettle) return;
			compactOnSettle = false;
			ctx.compact({ onComplete: () => compactionDone(), onError: () => compactionDone() });
		});
		pi.on("session_before_compact", async () => {
			await sleep(80);
		});
	};
	const h = await harness(t, { extra: compactor });
	const busy = h.blocking();
	let runDuringCompaction = false;
	const probe = () => {
		if (h.session.isCompacting && h.session.isStreaming) runDuringCompaction = true;
		return h.ai.fauxAssistantMessage(h.session.isCompacting ? "summary" : "ok");
	};
	h.faux.setResponses([h.startJob(h.gated("go", "DEFER-DONE")), busy.step, ...[1, 2, 3, 4, 5].map(() => probe)]);
	const run = h.session.prompt("go");
	await busy.entered;
	h.open("go");
	await waitUntil(() => h.manager().get("j1")?.status === "succeeded", 5000, "job");
	compactOnSettle = true;
	await h.session.abort(); // the held completion is sent from agent_settled: a deferred action
	await run;
	await compacted;
	await idle(h.session);
	assert.equal(runDuringCompaction, false, "an agent run executed while compaction was in progress");
});
