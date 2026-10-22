/** Integration tests: real processes, real process groups. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JobManager, type JobSnapshot } from "../src/jobs.ts";
import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { alive, readPid, sleep, tempDir, waitUntil } from "./helpers.ts";

function setup(t: Parameters<typeof tempDir>[0], over: Partial<ConstructorParameters<typeof JobManager>[0]> = {}) {
	const dir = tempDir(t);
	const done: JobSnapshot[] = [];
	const manager = new JobManager({ logRoot: join(dir, "logs"), killGraceMs: 300, drainMs: 300, onTerminal: j => done.push(j), ...over });
	t.after(() => manager.shutdown(200));
	return { dir, done, manager };
}

const readLog = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const pad = (n: number) => String(n).padStart(2, "0");
const today = () => {
	const d = new Date();
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const watchDefaults = { intervalSeconds: 0.1, timeoutSeconds: 5, checkTimeoutSeconds: 2, until: "success" as const };

test("successful job: notifies once with exit 0 and logs output", async t => {
	const { dir, done, manager } = setup(t);
	const job = manager.start({ command: "echo hello; echo err >&2", cwd: dir, timeoutSeconds: 10, label: "greet" });
	assert.equal(job.status, "running");
	assert.match(job.logPath, /logs\/\d{4}-\d{2}-\d{2}\/\d{6}-[0-9a-f]{6}-j1\.log$/);
	await waitUntil(() => done.length === 1, 5000, "completion");
	await sleep(100);
	assert.equal(done.length, 1);
	assert.equal(done[0].status, "succeeded");
	assert.equal(done[0].exitCode, 0);
	// stdout and stderr are separate pipes: both must be logged, in either order.
	const lines = (s: string) => s.trim().split("\n").sort();
	assert.deepEqual(lines(readFileSync(job.logPath, "utf8")), ["err", "hello"]);
	assert.deepEqual(lines(manager.notificationTail(done[0], 40, 4096).text), ["err", "hello"]);
	assert.equal(manager.runningCount, 0);
});

test("non-zero exit is reported as failed with its exit code", async t => {
	const { dir, done, manager } = setup(t);
	manager.start({ command: "echo nope; exit 3", cwd: dir, timeoutSeconds: 10 });
	await waitUntil(() => done.length === 1);
	assert.equal(done[0].status, "failed");
	assert.equal(done[0].exitCode, 3);
});

test("timeout kills the whole process group, grandchild included", async t => {
	const { dir, done, manager } = setup(t);
	const cmd = `sleep 100 & echo $! > gc.pid; echo $$ > leader.pid; sleep 100`;
	manager.start({ command: cmd, cwd: dir, timeoutSeconds: 1 });
	await waitUntil(() => existsSync(join(dir, "gc.pid")) && existsSync(join(dir, "leader.pid")));
	const gc = readPid(join(dir, "gc.pid"));
	const leader = readPid(join(dir, "leader.pid"));
	assert.ok(alive(gc) && alive(leader));
	await waitUntil(() => done.length === 1, 5000, "timeout");
	assert.equal(done[0].status, "timed_out");
	await waitUntil(() => !alive(gc) && !alive(leader), 3000, "group to die");
});

test("SIGTERM-ignoring group is SIGKILLed after the grace period", async t => {
	const { dir, done, manager } = setup(t);
	manager.start({ command: `trap '' TERM; sleep 100 & echo $! > gc.pid; sleep 100`, cwd: dir, timeoutSeconds: 0.5 });
	await waitUntil(() => existsSync(join(dir, "gc.pid")));
	const gc = readPid(join(dir, "gc.pid"));
	await waitUntil(() => done.length === 1, 5000, "timeout");
	assert.equal(done[0].status, "timed_out");
	assert.equal(done[0].signal, "SIGKILL");
	await waitUntil(() => !alive(gc), 3000, "grandchild to die");
});

test("background leftovers of a finished job are stopped", async t => {
	const { dir, done, manager } = setup(t);
	manager.start({ command: `sleep 100 & echo $! > gc.pid`, cwd: dir, timeoutSeconds: 10 });
	await waitUntil(() => done.length === 1);
	assert.equal(done[0].status, "succeeded");
	const gc = readPid(join(dir, "gc.pid"));
	await waitUntil(() => !alive(gc), 3000, "leftover to die");
});

test("kill stops the group, returns the final state and sends no notification", async t => {
	const { dir, done, manager } = setup(t);
	const job = manager.start({ command: `sleep 100 & echo $! > gc.pid; sleep 100`, cwd: dir, timeoutSeconds: 60 });
	await waitUntil(() => existsSync(join(dir, "gc.pid")));
	const gc = readPid(join(dir, "gc.pid"));
	const killed = await manager.kill(job.id);
	assert.equal(killed.status, "killed");
	assert.equal(killed.killedBy, "request");
	await waitUntil(() => !alive(gc), 3000, "grandchild to die");
	await sleep(200);
	assert.equal(done.length, 0);
	assert.equal((await manager.kill(job.id)).status, "killed"); // idempotent
	await assert.rejects(manager.kill("j99"), /No job with id j99/);
});

test("watch matches after the file appears (N checks)", async t => {
	const { dir, done, manager } = setup(t);
	const flag = join(dir, "ready");
	const job = manager.watch({ ...watchDefaults, check: `test -f ready && echo found`, cwd: dir, label: "ready file", timeoutSeconds: 30 });
	// Create the file only once three failed checks have been observed, whatever the load.
	await waitUntil(() => /--- check 3 · .* · exit 1 ---/.test(readLog(job.logPath)), 20_000, "three failed checks");
	assert.equal(done.length, 0);
	writeFileSync(flag, "");
	await waitUntil(() => done.length === 1, 20_000, "watch match");
	assert.equal(done[0].id, job.id);
	assert.equal(done[0].status, "matched");
	assert.ok(done[0].checks! >= 4, `checks=${done[0].checks}`);
	assert.equal(done[0].lastCheck?.output, "found");
	assert.match(readFileSync(job.logPath, "utf8"), /--- check 1 · .* · exit 1 ---/);
});

test("watch until failure and until change", async t => {
	const { dir, done, manager } = setup(t);
	writeFileSync(join(dir, "state"), "pending");
	const a = manager.watch({ ...watchDefaults, check: `grep -q pending state`, cwd: dir, until: "failure", timeoutSeconds: 30 });
	const b = manager.watch({ ...watchDefaults, check: `cat state`, cwd: dir, until: "change", timeoutSeconds: 30 });
	// Change the state only once both watches have completed their initial check (the
	// "change" baseline), however slow the machine is.
	await waitUntil(() => [a, b].every(w => /--- check 1 · /.test(readLog(w.logPath))), 20_000, "initial checks");
	assert.equal(done.length, 0);
	writeFileSync(join(dir, "state"), "done");
	await waitUntil(() => done.length === 2, 20_000, "both watches");
	assert.deepEqual(done.map(j => j.status), ["matched", "matched"]);
	assert.equal(done.find(j => j.until === "change")!.lastCheck!.output, "done");
});

test("watch timeout reports the last completed check's output, even if it cuts a check short", async t => {
	const { dir, done, manager } = setup(t);
	// Checks after the first hang, so the watch's deadline always lands inside a running check.
	const check = `if [ -f seen ]; then sleep 30; fi; touch seen; echo still pending; exit 1`;
	const w = manager.watch({ ...watchDefaults, check, cwd: dir, timeoutSeconds: 30, checkTimeoutSeconds: 60 });
	// Drive the deadline only after a completed check has been observed.
	await waitUntil(() => /--- check 1 · .* · exit 1 ---/.test(readLog(w.logPath)), 20_000, "first completed check");
	await waitUntil(() => manager.get(w.id)?.checks === 2, 5000, "second check running");
	await manager.kill(w.id); // same interruption path as the deadline; deterministic timing
	const final = manager.get(w.id)!;
	assert.equal(final.status, "killed");
	assert.equal(final.lastCheck?.output, "still pending");
	assert.equal(manager.notificationTail(final, 40, 4096).text, "still pending");
});

test("watch timeout settles as timed_out with the last completed output", async t => {
	const { dir, done, manager } = setup(t);
	const check = `if [ -f seen ]; then sleep 30; fi; touch seen; echo still pending; exit 1`;
	const w = manager.watch({ ...watchDefaults, check, cwd: dir, timeoutSeconds: 4, checkTimeoutSeconds: 60 });
	// The first check completes in milliseconds; the deadline must find a completed check.
	await waitUntil(() => /--- check 1 · .* · exit 1 ---/.test(readLog(w.logPath)), 3000, "first completed check before the deadline");
	await waitUntil(() => done.length === 1, 10_000, "watch timeout");
	assert.equal(done[0].status, "timed_out");
	assert.equal(done[0].checks, 2, "the deadline cut the hanging second check");
	assert.equal(done[0].lastCheck?.output, "still pending");
});

test("a hung check is killed by the per-check timeout and the watch continues", async t => {
	const { dir, done, manager } = setup(t);
	// First check hangs (with a grandchild); later checks succeed.
	const cmd = `if [ ! -f first ]; then touch first; sleep 100 & echo $! > gc.pid; sleep 100; fi; echo ok`;
	manager.watch({ ...watchDefaults, check: cmd, cwd: dir, checkTimeoutSeconds: 0.4 });
	await waitUntil(() => done.length === 1, 5000, "watch");
	assert.equal(done[0].status, "matched");
	assert.equal(done[0].checks, 2);
	await waitUntil(() => !alive(readPid(join(dir, "gc.pid"))), 3000, "hung check's grandchild to die");
	assert.match(readFileSync(done[0].logPath, "utf8"), /--- check 1 · .* · timed out ---/);
});

test("concurrency cap rejects with a clear error", async t => {
	const { dir, manager } = setup(t, { maxRunning: 2 });
	manager.start({ command: "sleep 100", cwd: dir, timeoutSeconds: 60 });
	manager.start({ command: "sleep 100", cwd: dir, timeoutSeconds: 60 });
	assert.throws(() => manager.start({ command: "true", cwd: dir, timeoutSeconds: 60 }), /Too many running background jobs \(2\/2\)/);
});

test("watches have their own cap and do not use command slots", async t => {
	const { dir, manager } = setup(t, { maxRunning: 1, maxRunningWatches: 2 });
	manager.watch({ ...watchDefaults, check: "exit 1", cwd: dir, intervalSeconds: 5 });
	manager.watch({ ...watchDefaults, check: "exit 1", cwd: dir, intervalSeconds: 5 });
	manager.start({ command: "sleep 100", cwd: dir, timeoutSeconds: 60 }); // watches don't block commands
	assert.throws(() => manager.watch({ ...watchDefaults, check: "exit 1", cwd: dir, intervalSeconds: 5 }), /Too many running background watches \(2\/2\)/);
	assert.throws(() => manager.start({ command: "true", cwd: dir, timeoutSeconds: 60 }), /Too many running background jobs \(1\/1\)/);
});

test("invalid cwd is rejected without spawning", t => {
	const { dir, manager } = setup(t);
	assert.throws(() => manager.start({ command: "true", cwd: join(dir, "nope"), timeoutSeconds: 5 }), /cwd is not an existing directory/);
	assert.equal(manager.runningCount, 0);
});

test("shutdown kills every running group silently and refuses new jobs", async t => {
	const { dir, done, manager } = setup(t);
	manager.start({ command: `sleep 100 & echo $! > a.pid; sleep 100`, cwd: dir, timeoutSeconds: 60 });
	manager.start({ command: `trap '' TERM; sleep 100 & echo $! > b.pid; sleep 100`, cwd: dir, timeoutSeconds: 60 });
	manager.watch({ ...watchDefaults, check: `sleep 100`, cwd: dir, checkTimeoutSeconds: 60 });
	await waitUntil(() => existsSync(join(dir, "a.pid")) && existsSync(join(dir, "b.pid")));
	const pids = [readPid(join(dir, "a.pid")), readPid(join(dir, "b.pid"))];
	await sleep(100);
	await manager.shutdown(200);
	await waitUntil(() => pids.every(p => !alive(p)), 3000, "all groups to die");
	assert.equal(done.length, 0);
	assert.throws(() => manager.start({ command: "true", cwd: dir, timeoutSeconds: 5 }), /shutting down/);
});

test("until change detects a change outside the retained output tail", async t => {
	const { dir, done, manager } = setup(t, { checkOutputBytes: 256 });
	writeFileSync(join(dir, "state"), "v1");
	// The changing part comes first, followed by 4000 identical bytes: the 256-byte tail never changes.
	const job = manager.watch({ ...watchDefaults, check: `cat state; head -c 4000 /dev/zero | tr '\\0' x`, cwd: dir, until: "change", timeoutSeconds: 10 });
	await waitUntil(() => /--- check 2 · .* · exit 0 ---/.test(readLog(job.logPath)), 8000, "two unchanged checks");
	assert.equal(done.length, 0);
	writeFileSync(join(dir, "state"), "v2");
	await waitUntil(() => done.length === 1, 9000, "watch to settle");
	assert.equal(done[0].status, "matched");
});

test("a log file that cannot be opened rolls the job back", async t => {
	const { dir, manager } = setup(t, { maxRunning: 1 });
	const dayDir = join(dir, "logs", today());
	mkdirSync(dayDir, { recursive: true });
	chmodSync(dayDir, 0o500);
	t.after(() => {
		try {
			chmodSync(dayDir, 0o700);
		} catch {}
	});
	assert.throws(() => manager.start({ command: "true", cwd: dir, timeoutSeconds: 5 }), /EACCES/);
	assert.equal(manager.runningCount, 0);
	assert.deepEqual(manager.list(), []);
	chmodSync(dayDir, 0o700);
	manager.start({ command: "true", cwd: dir, timeoutSeconds: 5 }); // the cap slot was not leaked
});

test("a synchronous spawn failure (NUL byte) rolls back and closes the log fd", t => {
	const { dir, manager, done } = setup(t, { maxRunning: 1 });
	const openFds = () => readdirSync("/dev/fd").length;
	const before = openFds();
	assert.throws(() => manager.start({ command: "echo a\0b", cwd: dir, timeoutSeconds: 5 }), /null bytes/);
	assert.equal(openFds(), before, "log fd leaked");
	assert.equal(manager.runningCount, 0);
	assert.throws(() => manager.watch({ ...watchDefaults, check: "echo a\0b", cwd: dir }), /null bytes/);
	assert.equal(manager.runningCount, 0);
	assert.deepEqual(manager.list(), []);
	assert.equal(done.length, 0);
	manager.start({ command: "true", cwd: dir, timeoutSeconds: 5 }); // the cap slot was not leaked
});

test("onActiveChange tracks ownership of running processes", async t => {
	const events: boolean[] = [];
	const { dir, done, manager } = setup(t, { onActiveChange: a => events.push(a) });
	assert.deepEqual(events, []);
	manager.start({ command: "true", cwd: dir, timeoutSeconds: 5 });
	assert.deepEqual(events, [true]);
	await waitUntil(() => done.length === 1);
	await waitUntil(() => events.length === 2);
	assert.deepEqual(events, [true, false]);
	assert.equal(manager.ownsProcesses, false);
});

test("group signals are only sent while the group leader exists (no PGID-reuse window)", async t => {
	const origKill = process.kill;
	const violations: string[] = [];
	(process as any).kill = function (pid: number, signal?: string | number) {
		if (typeof pid === "number" && pid < 0) {
			let leader = true;
			try {
				origKill.call(process, -pid, 0);
			} catch {
				leader = false;
			}
			if (!leader) violations.push(`${signal ?? "SIGTERM"} to group ${-pid} after its leader was gone`);
		}
		return origKill.call(process, pid, signal as any);
	};
	t.after(() => {
		process.kill = origKill;
	});
	const { dir, done, manager } = setup(t);
	// Normal exit leaving a TERM-ignoring leftover, a timeout, and an explicit kill.
	manager.start({ command: `trap '' TERM; sleep 30 & echo $! > left.pid`, cwd: dir, timeoutSeconds: 10 });
	manager.start({ command: `sleep 30`, cwd: dir, timeoutSeconds: 0.3 });
	const k = manager.start({ command: `trap '' TERM; sleep 30`, cwd: dir, timeoutSeconds: 10 });
	await sleep(100);
	await manager.kill(k.id);
	await waitUntil(() => done.length === 2, 5000, "exit and timeout");
	await waitUntil(() => existsSync(join(dir, "left.pid")) && !alive(readPid(join(dir, "left.pid"))), 5000, "leftover to be killed");
	await waitUntil(() => !manager.ownsProcesses, 5000, "all supervisors reaped");
	// Escalation timers are cleared when a supervisor is reaped, so none can fire after this.
	assert.deepEqual(violations, []);
});

test("leader exits while a TERM-ignoring descendant survives: ownership holds through escalation", async t => {
	const events: boolean[] = [];
	const { dir, done, manager } = setup(t, { killGraceMs: 2000, onActiveChange: a => events.push(a) });
	manager.start({ command: `trap '' TERM; sleep 30 & echo $! > d.pid`, cwd: dir, timeoutSeconds: 10 });
	await waitUntil(() => done.length === 1, 5000, "job to finish");
	assert.equal(done[0].status, "succeeded");
	const d = readPid(join(dir, "d.pid"));
	// The supervisor has sent SIGTERM (ignored) and waits the 2 s grace period before SIGKILL.
	assert.ok(alive(d), "descendant ignores SIGTERM, so it lives until the escalation");
	assert.equal(manager.ownsProcesses, true, "manager must stay registered while the descendant lives");
	await waitUntil(() => !alive(d), 4000, "descendant to be SIGKILLed after the grace period");
	await waitUntil(() => !manager.ownsProcesses, 2000, "supervisor reaped");
	assert.deepEqual(events, [true, false]);
});

// A descendant that leaves the process group (setsid) and keeps stdout open. It writes its pid
// outside the test's temp dir (after-hooks remove that dir first) and exits on its own after
// 20 s at the latest; the test kills it earlier.
function escaper(t: Parameters<typeof tempDir>[0]) {
	const pidFile = join(tmpdir(), `pi-jobs-esc-${process.pid}-${Math.random().toString(36).slice(2)}.pid`);
	t.after(() => {
		try {
			process.kill(readPid(pidFile), "SIGKILL");
		} catch {}
		rmSync(pidFile, { force: true });
	});
	const command = `perl -e 'use POSIX; if (fork() == 0) { POSIX::setsid(); open(my $f, ">", "${pidFile}"); print $f $$; close $f; sleep 20; exit 0 } exit 0'`;
	return { command, pidFile };
}

test("watch: an escaped descendant holding stdout cannot stall the check", async t => {
	const { dir, done, manager } = setup(t);
	const esc = escaper(t);
	const started = Date.now();
	manager.watch({ ...watchDefaults, check: `${esc.command}; echo checked`, cwd: dir, timeoutSeconds: 20 });
	await waitUntil(() => done.length === 1, 5000, "watch to settle despite the open pipe");
	assert.equal(done[0].status, "matched");
	assert.equal(done[0].lastCheck?.output, "checked");
	assert.ok(Date.now() - started < 4000);
	await waitUntil(() => existsSync(esc.pidFile), 2000, "escaped pid");
	assert.ok(alive(readPid(esc.pidFile)), "the escaped process is outside our reach (the test kills it)");
});

test("job_start: an escaped descendant holding stdout cannot stall completion", async t => {
	const { dir, done, manager } = setup(t);
	const esc = escaper(t);
	manager.start({ command: `${esc.command}; echo finished`, cwd: dir, timeoutSeconds: 20 });
	await waitUntil(() => done.length === 1, 5000, "job to settle despite the open pipe");
	assert.equal(done[0].status, "succeeded");
	assert.match(readFileSync(done[0].logPath, "utf8"), /finished/);
});

test("shutdown with a check stalled by an escaped descendant: bounded, nothing left running", async t => {
	const { dir, manager } = setup(t, { drainMs: 60_000 });
	const esc = escaper(t);
	manager.watch({ ...watchDefaults, check: `echo $$ > leader.pid; ${esc.command}; exit 1`, cwd: dir, timeoutSeconds: 60 });
	await waitUntil(() => existsSync(esc.pidFile) && existsSync(join(dir, "leader.pid")), 5000, "escaped process and leader pid");
	const leader = readPid(join(dir, "leader.pid"));
	// Observe that the check's leader has exited (and been reaped); only the escaped pipe holder remains.
	await waitUntil(() => !alive(leader), 5000, "check leader to exit");
	const started = Date.now();
	await manager.shutdown(200);
	assert.ok(Date.now() - started < 2000, "shutdown must not wait for the pipe");
	assert.equal(manager.runningCount, 0);
	await waitUntil(() => !manager.ownsProcesses, 3000, "supervisors reaped");
});

test("log size cap: output beyond the cap is discarded, the job keeps running, the cap is reported", async t => {
	const { dir, done, manager } = setup(t, { logCapBytes: 100_000 });
	manager.start({ command: `head -c 300000 /dev/zero | tr '\\0' x; echo; touch after-cap; echo last-line`, cwd: dir, timeoutSeconds: 20 });
	await waitUntil(() => done.length === 1, 10_000, "job");
	assert.equal(done[0].status, "succeeded");
	assert.ok(existsSync(join(dir, "after-cap")), "the job must keep running after the cap");
	const size = statSync(done[0].logPath).size;
	assert.ok(size >= 100_000 && size < 100_300, `log size ${size}`);
	assert.match(readFileSync(done[0].logPath, "utf8"), /\[pi-jobs: log truncated at 98 KB; further output is discarded, the job keeps running\]\n$/);
	assert.equal(done[0].logTruncated, true);
});


test("list snapshots retain watch configuration additively and plain jobs have no watch fields", async t => {
	const { dir, manager } = setup(t);
	const watch = manager.watch({ ...watchDefaults, check: "false", cwd: dir, label: "ready", intervalSeconds: 3, timeoutSeconds: 30 });
	const command = manager.start({ command: "sleep 10", cwd: dir, label: "build", timeoutSeconds: 20 });
	const listed = manager.list();
	assert.deepEqual(listed.find(j => j.id === watch.id), watch);
	assert.deepEqual([watch.label, watch.until, watch.intervalSeconds, watch.timeoutSeconds], ["ready", "success", 3, 30]);
	assert.deepEqual([command.label, command.timeoutSeconds, command.until, command.intervalSeconds], ["build", 20, undefined, undefined]);
	listed[0].intervalSeconds = 99;
	assert.equal(manager.list().find(j => j.id === watch.id)!.intervalSeconds, 3);
});
