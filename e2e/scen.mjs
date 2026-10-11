// End-to-end scenarios against a real `pi --mode rpc` (about a cent per run).
// Usage: node scen.mjs <id>   ids: 1 2 3 4 5 6a 6b 7 8a 8b
// Exit: 0 PASS, 1 FAIL, 2 hard timeout, 64 unknown scenario id.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import { killOwned, owned, Pi, sleep } from "./driver.mjs";

const SCENARIOS = ["1", "2", "3", "4", "5", "6a", "6b", "7", "8a", "8b"];
const id = process.argv[2];
if (!SCENARIOS.includes(id)) {
	console.error(`unknown scenario "${id ?? ""}"; expected one of: ${SCENARIOS.join(" ")}`);
	process.exit(64);
}

// Everything this run creates is unique to it: temp dir (also pi's cwd) and process marker.
const dir = fs.mkdtempSync("/tmp/pijobs-e2e-");
const marker = `pijobs-e2e-${randomUUID()}`;
const pi = new Pi(dir);
let failed = false;

const out = (k, v) => console.log(`${k}:`, typeof v === "string" ? v : JSON.stringify(v));
const short = s => (s.length > 400 ? `${s.slice(0, 400)}…` : s);
function report(name, pass, note) {
	out(`RESULT ${name}`, pass ? "PASS" : "FAIL");
	if (note) out("note", note);
	if (!pass) failed = true;
}
function cleanup() {
	pi.kill();
	killOwned(marker);
	fs.rmSync(dir, { recursive: true, force: true });
}
const hard = setTimeout(() => {
	console.log("HARD TIMEOUT");
	cleanup();
	process.exit(2);
}, 150_000);

/** Wait for the first turn to settle, then for the wake-up message and its run to settle. */
async function promptAndWake(prompt, wakeMs = 40_000) {
	pi.prompt(prompt);
	if (!(await pi.settled(60_000))) throw new Error("first turn did not settle");
	const wake = await pi.waitFor(e => e.type === "message_end" && e.message?.role === "custom", wakeMs);
	if (!wake) throw new Error("no wake-up message");
	if (!(await pi.settled(40_000, pi.events.indexOf(wake)))) throw new Error("wake-up run did not settle");
}

function show() {
	out("tools", pi.tools());
	out("completions", pi.completions().map(m => ({ t: m.t, text: short(m.text) })));
	out("assistant", pi.assistantTexts().map(short));
}

const scenarios = {
	async 1() {
		await promptAndWake("Use job_start with command `sleep 3; echo OK-MARKER`, timeoutSeconds 30, then end your turn immediately.");
		show();
		const ms = pi.completions();
		report("1 success", ms.length === 1 && /succeeded/.test(ms[0].text) && /exit 0/.test(ms[0].text) && /OK-MARKER/.test(ms[0].text));
	},
	async 2() {
		await promptAndWake("Use job_start with command `echo boom; exit 7`, timeoutSeconds 30, then end your turn immediately.");
		show();
		const ms = pi.completions();
		report("2 failure", ms.length === 1 && /exit 7/.test(ms[0].text) && /boom/.test(ms[0].text));
	},
	async 3() {
		await promptAndWake(`Use job_start with command \`exec -a ${marker} sleep 60\`, timeoutSeconds 3, then end your turn immediately.`);
		show();
		const left = owned(marker);
		out("owned processes left", left);
		const ms = pi.completions();
		report("3 timeout", ms.length === 1 && /timed out/.test(ms[0].text) && left.length === 0);
	},
	async 4() {
		const flag = join(dir, "flag");
		setTimeout(() => fs.writeFileSync(flag, "x"), 15_000);
		await promptAndWake(`Use job_watch with check \`test -f ${flag}\`, intervalSeconds 10, timeoutSeconds 90, then end your turn immediately.`, 80_000);
		show();
		const ms = pi.completions();
		report("4 watch", ms.length === 1 && /matched/.test(ms[0].text));
	},
	async 5() {
		pi.prompt(
			"In ONE turn do this in order: job_start `sleep 2; echo A-DONE` (timeoutSeconds 30), job_start `sleep 3; echo B-DONE` (timeoutSeconds 30), " +
				"then run the bash tool with `sleep 8; echo FG-DONE`. After bash returns, reply just 'fg finished' and end the turn.",
		);
		// Both jobs finish during the bash call; the run continues with their completion(s) and settles once.
		if (!(await pi.settled(90_000))) throw new Error("run did not settle");
		show();
		const ms = pi.completions();
		const count = re => ms.filter(m => re.test(m.text)).length;
		const bash = pi.events.filter(e => e.type === "tool_execution_end" && e.toolName === "bash");
		const firstEnd = pi.events.find(e => e.type === "agent_end")?._t ?? Infinity;
		report(
			"5 busy",
			count(/A-DONE/) === 1 && count(/B-DONE/) === 1 && bash.length === 1 && !bash[0].isError && /FG-DONE/.test(JSON.stringify(bash[0].result)),
			`completion messages ${ms.length} (batched=${ms.length === 1}); first agent_end ${firstEnd}`,
		);
	},
	async 6() {
		pi.prompt(`Use job_start with command \`exec -a ${marker} sleep 301\`, timeoutSeconds 600, then end your turn immediately.`);
		if (!(await pi.settled(60_000))) throw new Error("turn did not settle");
		out("tools", pi.tools());
		const before = owned(marker);
		out("owned before exit", before);
		if (id === "6a") pi.p.stdin.end();
		else process.kill(pi.pid, "SIGTERM");
		const exit = await Promise.race([pi.exited, sleep(10_000).then(() => null)]);
		out("pi exit", exit ?? "STILL RUNNING");
		await sleep(2000); // the exit hook SIGKILLs synchronously; allow the kernel to reap
		const left = owned(marker);
		out("owned after exit", left);
		report(`${id} exit cleanup`, before.length > 0 && exit !== null && left.length === 0);
	},
	async 7() {
		await promptAndWake("Wait for a background command `sleep 5; echo DONE` and tell me the output when it is ready");
		show();
		const tools = pi.tools();
		const ms = pi.completions();
		report("7 no-poll", tools.length === 1 && /^job_/.test(tools[0].name) && ms.length === 1 && /DONE/.test(ms[0].text));
	},
	async 8() {
		// A job finishes while another turn streams; then Escape (8a: clear_queue + abort) or RPC abort (8b).
		const done = join(dir, "job-done");
		pi.prompt(
			`In ONE turn: first call job_start with command \`sleep 3; echo ABORT-MARKER; touch ${done}\` and timeoutSeconds 30, ` +
				"then call the bash tool with `sleep 25; echo FG` and wait for it. Do nothing else.",
		);
		const bash = await pi.waitFor(e => e.type === "tool_execution_start" && e.toolName === "bash", 60_000);
		if (!bash) throw new Error("bash never started");
		// Precondition 1: the job has completed (its last command wrote the marker file).
		const deadline = Date.now() + 20_000;
		while (!fs.existsSync(done) && Date.now() < deadline) await sleep(100);
		if (!fs.existsSync(done)) throw new Error("precondition failed: the job did not complete");
		await sleep(500); // let pi-jobs see the job's exit (pipe close and status) before aborting
		// Precondition 2: the foreground bash is still running, i.e. the turn is still streaming.
		if (pi.events.some(e => e.type === "tool_execution_end" && e.toolName === "bash"))
			throw new Error("precondition failed: the foreground bash already finished");
		const before = pi.completions().length;
		if (id === "8a") pi.send({ type: "clear_queue" });
		pi.send({ type: "abort" });
		const abortAt = pi.now();
		const wake = await pi.waitFor(e => e.type === "message_end" && e.message?.role === "custom", 40_000);
		if (!wake) throw new Error("no completion after the abort");
		if (!(await pi.settled(40_000, pi.events.indexOf(wake)))) throw new Error("wake-up run did not settle");
		show();
		const ms = pi.completions();
		report(
			`${id} abort`,
			before === 0 && ms.length === 1 && /ABORT-MARKER/.test(ms[0].text) && ms[0].t > abortAt,
			`completions before abort ${before}; delivered at ${ms[0]?.t}, abort at ${abortAt}`,
		);
	},
};

try {
	await scenarios[id.replace(/[ab]$/, "")]();
} catch (e) {
	console.log("ERROR", e.message);
	failed = true;
}
out("cost", pi.cost());
if (pi.stderr.trim()) out("pi stderr", short(pi.stderr.replace(/^Warning: Extension package .*Host-provided.*\n?/gm, "")));
clearTimeout(hard);
cleanup();
process.exit(failed ? 1 : 0);
