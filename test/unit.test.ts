import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cleanOutput, lastBytes, readTail, tailBuffer, tailText, TailSink } from "../src/tail.ts";
import { outcomeFromStatus } from "../src/supervisor.ts";
import { LogWriter } from "../src/logwriter.ts";
import { evaluateWatch, type CheckResult } from "../src/watch.ts";
import { exitText, formatBatch, formatDuration, formatJobList, formatNotification } from "../src/format.ts";
import { resolveManagerOptions, settleSnapshot, type JobSnapshot } from "../src/jobs.ts";
import { pruneLogs } from "../src/logs.ts";
import { tempDir } from "./helpers.ts";

const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${i + from}`).join("\n");

test("tailText keeps the last N lines and reports truncation", () => {
	assert.deepEqual(tailText("a\nb\nc\n", 5, 1000), { text: "a\nb\nc", truncated: false });
	const t = tailText(lines(100), 3, 10_000);
	assert.equal(t.text, "line 98\nline 99\nline 100");
	assert.equal(t.truncated, true);
});

test("tailText byte cap drops the partial first line", () => {
	const t = tailText(lines(1000), 40, 64);
	assert.ok(Buffer.byteLength(t.text) <= 64);
	assert.ok(t.truncated);
	for (const l of t.text.split("\n")) assert.match(l, /^line \d+$/);
	assert.ok(t.text.endsWith("line 1000"));
});

test("tailText never splits into broken UTF-8 at the start", () => {
	const t = tailText("ø".repeat(100), 10, 7); // one long line, cap lands mid-character
	assert.ok(!t.text.includes("\uFFFD"));
	assert.ok(t.text.length > 0 && /^ø+$/.test(t.text));
});

test("cleanOutput strips ANSI and collapses carriage-return redraws", () => {
	assert.equal(cleanOutput("\x1b[32mok\x1b[0m\n10%\r50%\r100%\r\n"), "ok\n100%\n");
});

test("tailBuffer with complete=false always reports truncation", () => {
	assert.equal(tailBuffer(Buffer.from("x\ny"), 10, 100, false).truncated, true);
});

test("readTail reads only the end of a large file", t => {
	const dir = tempDir(t);
	const path = join(dir, "big.log");
	writeFileSync(path, lines(200_000)); // ~2.5 MB
	const tail = readTail(path, 40, 4096);
	assert.equal(tail.text.split("\n").length, 40);
	assert.ok(tail.text.endsWith("line 200000"));
	assert.deepEqual(readTail(join(dir, "missing.log"), 5, 100), { text: "", truncated: false });
});

test("TailSink never retains more than its capacity, even for oversized chunks", () => {
	const sink = new TailSink(64 * 1024);
	sink.push(Buffer.alloc(1024, 0x61));
	sink.push(Buffer.alloc(200 * 1024, 0x62)); // one huge chunk
	assert.equal(sink.retainedBytes, 64 * 1024);
	sink.push(Buffer.alloc(10, 0x63));
	assert.equal(sink.retainedBytes, 64 * 1024);
	const out = sink.toBuffer();
	assert.equal(out.length, 64 * 1024);
	assert.equal(out.subarray(-10).toString(), "c".repeat(10));
	assert.equal(out[0], 0x62);
	assert.ok(sink.dropped);
	const small = new TailSink(100);
	small.push(Buffer.alloc(60));
	small.push(Buffer.alloc(60)); // straddles the boundary
	assert.equal(small.retainedBytes, 100);
});

test("TailSink keeps only the most recent bytes", () => {
	const sink = new TailSink(10);
	for (let i = 0; i < 10; i++) sink.push(Buffer.from(`${i}abc\n`));
	const out = sink.toBuffer().toString();
	assert.equal(out.length, 10);
	assert.ok(out.endsWith("9abc\n"));
	assert.ok(sink.dropped);
});

const check = (exitCode: number | null, output = "", timedOut = false): CheckResult => ({ exitCode, signal: exitCode === null ? "SIGTERM" : null, timedOut, output });

test("evaluateWatch: success and failure", () => {
	assert.equal(evaluateWatch("success", check(0), undefined).matched, true);
	assert.equal(evaluateWatch("success", check(1), undefined).matched, false);
	assert.equal(evaluateWatch("failure", check(1), undefined).matched, true);
	assert.equal(evaluateWatch("failure", check(null), undefined).matched, true);
	assert.equal(evaluateWatch("failure", check(0), undefined).matched, false);
});

test("evaluateWatch: timed-out checks are inconclusive", () => {
	assert.deepEqual(evaluateWatch("failure", check(null, "", true), undefined), { matched: false, baseline: undefined });
	assert.equal(evaluateWatch("change", check(null, "", true), "x").matched, false);
});

test("evaluateWatch: change compares against the first conclusive check", () => {
	let ev = evaluateWatch("change", check(0, "pending\n"), undefined);
	assert.equal(ev.matched, false);
	ev = evaluateWatch("change", check(0, "pending"), ev.baseline); // whitespace-only difference
	assert.equal(ev.matched, false);
	assert.equal(evaluateWatch("change", check(1, "pending"), ev.baseline).matched, true);
	assert.equal(evaluateWatch("change", check(0, "done"), ev.baseline).matched, true);
});

test("formatDuration", () => {
	assert.equal(formatDuration(4_400), "4s");
	assert.equal(formatDuration(133_000), "2m 13s");
	assert.equal(formatDuration(3 * 3600_000 + 5 * 60_000), "3h 5m");
});

const snap = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
	id: "j1",
	kind: "command",
	command: "npm test",
	cwd: "/repo",
	logPath: "/logs/j1.log",
	startedAt: 0,
	status: "running",
	timeoutSeconds: 600,
	...over,
});

test("formatNotification: command job", () => {
	const text = formatNotification(snap({ status: "failed", exitCode: 2, endedAt: 65_000, label: "tests" }), { text: "boom", truncated: true });
	assert.equal(text, "Job j1 failed: tests\nexit 2 · after 1m 5s\ncommand: npm test\nlog: /logs/j1.log\noutput (tail):\nboom");
});

test("formatNotification: watch timeout without output", () => {
	const text = formatNotification(
		snap({ kind: "watch", status: "timed_out", until: "success", checks: 3, endedAt: 30_000, lastCheck: { exitCode: 1, signal: null, timedOut: false, output: "" } }),
		{ text: "", truncated: false },
	);
	assert.match(text, /^Watch j1 timed out: npm test\nuntil success · 3 checks · last check exit 1 · after 30s · timeout 600s\n/);
	assert.match(text, /\(no last check output\)$/);
});

test("formatJobList groups running and recent", () => {
	assert.equal(formatJobList([]), "No background jobs in this session.");
	const out = formatJobList([snap(), snap({ id: "j2", status: "succeeded", exitCode: 0, endedAt: 1000 })], 2000);
	assert.match(out, /^Running \(1\):\n  j1 · job · running · 2s — npm test\nRecent \(1\):\n  j2 · job · succeeded · exit 0 · 1s — npm test$/);
});

test("settleSnapshot allows exactly one terminal transition", () => {
	const s = snap();
	assert.equal(settleSnapshot(s, "timed_out", 10), true);
	assert.equal(settleSnapshot(s, "succeeded", 20, { exitCode: 0 }), false);
	assert.equal(s.status, "timed_out");
	assert.equal(s.endedAt, 10);
	assert.equal(s.exitCode, undefined);
});

test("pruneLogs removes only old *.log files in day directories", t => {
	const root = tempDir(t);
	const oldDay = join(root, "2020-01-01");
	const newDay = join(root, "2099-01-01");
	const other = join(root, "keep-me");
	for (const d of [oldDay, newDay, other]) mkdirSync(d);
	const old = Date.now() / 1000 - 8 * 86400;
	for (const [dir, name] of [[oldDay, "a.log"], [newDay, "b.log"], [other, "c.log"], [newDay, "old.txt"]]) {
		const p = join(dir, name);
		writeFileSync(p, "x");
		if (dir !== newDay || name === "old.txt") utimesSync(p, old, old);
	}
	assert.equal(pruneLogs(root), 1);
	assert.equal(existsSync(oldDay), false); // emptied day dir removed
	assert.equal(existsSync(join(newDay, "b.log")), true);
	assert.equal(existsSync(join(newDay, "old.txt")), true);
	assert.equal(existsSync(join(other, "c.log")), true);
});

test("evaluateWatch: change compares the full-output digest when present", () => {
	const a = { ...check(0, "same tail"), outputHash: "h1" };
	const b = { ...check(0, "same tail"), outputHash: "h2" };
	const ev = evaluateWatch("change", a, undefined);
	assert.equal(evaluateWatch("change", { ...a }, ev.baseline).matched, false);
	assert.equal(evaluateWatch("change", b, ev.baseline).matched, true);
});

test("resolveManagerOptions: explicit undefined never replaces a default", () => {
	const o = resolveManagerOptions({
		logRoot: "/x",
		onTerminal() {},
		maxRunning: undefined,
		killGraceMs: undefined,
		keepFinished: undefined,
		checkOutputBytes: undefined,
		env: undefined,
		onActiveChange: undefined,
	});
	assert.equal(o.maxRunning, 8);
	assert.equal(o.maxRunningWatches, 32);
	assert.equal(o.killGraceMs, 5000);
	assert.equal(o.keepFinished, 50);
	assert.equal(o.checkOutputBytes, 64 * 1024);
	assert.equal(o.env, process.env);
	assert.equal(typeof o.onActiveChange, "function");
	assert.equal(resolveManagerOptions({ logRoot: "/x", onTerminal() {}, maxRunning: 2 }).maxRunning, 2);
	const fromEnv = resolveManagerOptions({ logRoot: "/x", onTerminal() {}, env: { PI_JOBS_MAX_RUNNING: "12", PI_JOBS_MAX_WATCHES: "64" } });
	assert.equal(fromEnv.maxRunning, 12);
	assert.equal(fromEnv.maxRunningWatches, 64);
	const badEnv = resolveManagerOptions({ logRoot: "/x", onTerminal() {}, env: { PI_JOBS_MAX_RUNNING: "0", PI_JOBS_MAX_WATCHES: "lots" } });
	assert.equal(badEnv.maxRunning, 8);
	assert.equal(badEnv.maxRunningWatches, 32);
});

test("pruneLogs never follows symlinks out of the log root", t => {
	const root = tempDir(t);
	const outside = tempDir(t);
	const old = Date.now() / 1000 - 30 * 86400;
	const victim = join(outside, "victim.log");
	const target = join(outside, "target.log");
	for (const p of [victim, target]) {
		writeFileSync(p, "precious");
		utimesSync(p, old, old);
	}
	symlinkSync(outside, join(root, "2020-01-02")); // symlinked day directory
	const day = join(root, "2020-01-03");
	mkdirSync(day);
	symlinkSync(target, join(day, "linked.log")); // symlinked log file
	assert.equal(pruneLogs(root), 0);
	assert.equal(existsSync(victim), true);
	assert.equal(existsSync(target), true);
	assert.equal(existsSync(join(root, "2020-01-02")), true);
});

test("tail byte cap holds after decoding invalid UTF-8 (each bad byte decodes to 3 bytes)", () => {
	const t = tailBuffer(Buffer.alloc(4096, 0xff), 40, 4096);
	assert.ok(Buffer.byteLength(t.text) <= 4096, `got ${Buffer.byteLength(t.text)} bytes`);
	const lines = tailBuffer(Buffer.from("ok\n" + "\xff".repeat(10) + "\n" + Buffer.alloc(3000, 0xfe).toString("latin1")), 40, 1000);
	assert.ok(Buffer.byteLength(lines.text) <= 1000);
});

test("lastBytes keeps whole code points", () => {
	assert.equal(lastBytes("aé😀", 4), "😀");
	assert.equal(lastBytes("aé😀", 6), "é😀");
	assert.equal(lastBytes("aé😀", 3), "");
	assert.equal(lastBytes("abc", 10), "abc");
});

test("formatBatch: one completion is plain, several are numbered under one header", () => {
	const one = formatBatch([{ job: snap({ status: "succeeded", exitCode: 0, endedAt: 1000 }), tail: { text: "x", truncated: false } }]);
	assert.deepEqual(one.partOf, [0]);
	assert.match(one.parts[0], /^Job j1 succeeded/);
	const two = formatBatch([
		{ job: snap({ status: "succeeded", exitCode: 0, endedAt: 1000 }), tail: { text: "x", truncated: false } },
		{ job: snap({ id: "j2", status: "failed", exitCode: 1, endedAt: 1000 }), tail: { text: "y", truncated: false } },
	]);
	assert.deepEqual(two.partOf, [1, 2], "one content part per completion, after the header");
	assert.match(two.parts[1], /^\[1\/2\] Job j1 succeeded/);
	assert.match(two.parts.join(""), /^2 background jobs finished:\n\n\[1\/2\] Job j1 succeeded[\s\S]*\n\n\[2\/2\] Job j2 failed/);
});

test("formatNotification reports log truncation, log write errors and spawn errors", () => {
	const text = formatNotification(snap({ status: "failed", exitCode: null, endedAt: 1000, logTruncated: true, logError: "ENOSPC: no space left", error: "spawn bash ENOENT" }), { text: "", truncated: false });
	assert.match(text, /log: \/logs\/j1\.log \(truncated at the size cap\)/);
	assert.match(text, /log write error: ENOSPC: no space left \(later output was not logged\)/);
	assert.match(text, /error: spawn bash ENOENT/);
});

test("exit statuses above 128 are reported as a likely signal, not a verified one", () => {
	assert.deepEqual(outcomeFromStatus(143), { exitCode: 143, signal: null });
	assert.equal(exitText(0, null), "exit 0");
	assert.equal(exitText(143, null), "exit 143 (likely SIGTERM)");
	assert.equal(exitText(137, null), "exit 137 (likely SIGKILL)");
	assert.equal(exitText(255, null), "exit 255", "no signal 127: no inference");
	assert.equal(exitText(null, "SIGKILL"), "signal SIGKILL", "observed directly");
});

test("LogWriter caps the file and records write errors without throwing", t => {
	const dir = tempDir(t);
	const w = new LogWriter(join(dir, "a.log"), 10);
	w.write("12345");
	w.write("67890abc");
	w.write("more");
	w.close();
	assert.match(readFileSync(join(dir, "a.log"), "utf8"), /^1234567890\n\[pi-jobs: log truncated at 10 bytes;/);
	assert.equal(w.truncated, true);
	const e = new LogWriter(join(dir, "b.log"), 1000);
	closeSync((e as any).fd); // the descriptor goes bad underneath the writer
	assert.doesNotThrow(() => e.write("x"));
	assert.match(e.error ?? "", /EBADF/);
	assert.doesNotThrow(() => e.write("y"));
});
