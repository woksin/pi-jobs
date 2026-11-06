import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureOutput, classifyInboxExit, declaredIdentity, laneStatus, RECORD_BYTES } from "../src/subscription.ts";
import { expireReloadOwner, reserveSubscription, sessionOwners, stopOrphans, subscriptionReservations, type Owner } from "../src/ownership.ts";
import { Delivery, type Completion } from "../src/delivery.ts";
import { LogWriter } from "../src/logwriter.ts";
import { JobManager, type JobSnapshot } from "../src/jobs.ts";
import { sleep, waitUntil as waitFor } from "./helpers.ts";
import { tempDir } from "./helpers.ts";

function identity(t: Parameters<typeof tempDir>[0], lane = "L1") {
	const dir = tempDir(t);
	return declaredIdentity({ inboxDir: dir, lane, cwd: dir, env: {} });
}

function record(sequence: number, event: "match" | "terminal" = "match") {
	return Object.freeze({ completionId: crypto.randomUUID(), event, sequence,
		payload: Object.freeze({ id: "j1", kind: "subscription", command: "check", cwd: "/", logPath: "/log", startedAt: 0,
			timeoutSeconds: 10, status: event === "match" ? "running" : "timed_out" } as JobSnapshot),
		capture: captureOutput(Buffer.alloc(RECORD_BYTES, sequence % 256)),
	});
}

test("inbox exit protocol never treats error/signal/timeout as a match", () => {
	assert.equal(classifyInboxExit({ exitCode: 0, signal: null }), "match");
	assert.equal(classifyInboxExit({ exitCode: 1, signal: null }), "quiet");
	for (const exitCode of [null, 2, 127, 143]) assert.equal(classifyInboxExit({ exitCode, signal: null }), "failure");
	assert.equal(classifyInboxExit({ exitCode: 0, signal: null, error: "spawn" }), "failure");
	assert.equal(classifyInboxExit({ exitCode: 0, signal: null }, true), "failure");
});

test("capture owns immutable exact bytes and reports truncation", () => {
	const source = Buffer.from([0, 255, 128, 10]);
	const capture = captureOutput(source);
	source.fill(42);
	assert.deepEqual(Buffer.from(capture.data, "latin1"), Buffer.from([0, 255, 128, 10]));
	assert.ok(Object.isFrozen(capture));
	const large = captureOutput(Buffer.alloc(RECORD_BYTES + 1, 97));
	assert.equal(large.bytes, RECORD_BYTES);
	assert.equal(large.truncated, true);
});

test("status is bounded, fail-closed, and parked assessment never auto-resumes", t => {
	const id = identity(t);
	assert.equal(laneStatus(id).state, "eligible");
	mkdirSync(join(id.inboxDir, "status"));
	for (const line of ['working since 2020-01-01T00:00:00Z', 'waiting-on "x" until 2999-01-01T00:00:00Z',
		'barred-by "x" until 2999-01-01T00:00:00Z', 'closed reassigned-to L2 at 2020-01-01T00:00:00Z reason "done"']) {
		writeFileSync(id.statusPath, line + "\n");
		assert.equal(laneStatus(id).state, "eligible", line);
	}
	writeFileSync(id.statusPath, 'parked "owner" until 2020-01-01T00:00:00Z\n');
	assert.equal(laneStatus(id).state, "parked");
	for (const line of ["", "working since garbage", "working since 2020-02-30T00:00:00Z", "working since 2020-01-01T24:00:00Z", "parked invalid", "a".repeat(513), "working since 2020-01-01T00:00:00Z\nextra"]) {
		writeFileSync(id.statusPath, line);
		assert.equal(laneStatus(id).state, "invalid", line.slice(0, 30));
	}
	const directory = declaredIdentity({ inboxDir: id.inboxDir, lane: "L2", cwd: id.inboxDir, env: {} });
	mkdirSync(directory.statusPath);
	assert.equal(laneStatus(directory).state, "invalid");
	const fifo = declaredIdentity({ inboxDir: id.inboxDir, lane: "L3", cwd: id.inboxDir, env: {} });
	execFileSync("mkfifo", [fifo.statusPath]);
	assert.equal(laneStatus(fifo).state, "invalid");
});

test("canonical inbox/lane conflicts across sessions and aliases, not check spelling", t => {
	const id = identity(t);
	const alias = join(tempDir(t), "alias");
	symlinkSync(id.inboxDir, alias);
	const first = reserveSubscription(id, "session-one");
	t.after(() => first.reconcile());
	for (const inboxDir of [id.inboxDir + "/", join(id.inboxDir, "..", id.inboxDir.split("/").at(-1)!), alias]) {
		const other = declaredIdentity({ inboxDir, lane: id.lane, cwd: "/", env: {} });
		assert.throws(() => reserveSubscription(other, "session-two"), /already reserved/);
	}
	const differentLane = reserveSubscription(declaredIdentity({ inboxDir: alias, lane: "L2", cwd: "/", env: {} }), "session-two");
	const differentDir = reserveSubscription(identity(t), "session-two");
	t.after(() => { differentLane.reconcile(); differentDir.reconcile(); });
	assert.throws(() => declaredIdentity({ inboxDir: id.inboxDir, lane: "../L1", cwd: "/", env: {} }), /lane/);
	assert.throws(() => declaredIdentity({ inboxDir: id.inboxDir, lane: "L1", cwd: "/", env: { PI_LANE_ID: "L2" } }), /conflict/);
});

test("64 reservations charge active, terminal, parked, in-flight and recovery records until receipt", t => {
	const admitted = Array.from({ length: 64 }, (_, n) => reserveSubscription(identity(t, `L${n}`), `session-${n}`));
	t.after(() => admitted.forEach(r => r.reconcile()));
	const original = admitted.map((r, n) => {
		assert.equal(r.beginCheck(), true);
		const match = record(n);
		r.retain(match);
		r.endCheck();
		r.markSent(match.completionId);
		r.retire(record(n, "terminal"));
		return match;
	});
	assert.equal(subscriptionReservations().size, 64);
	for (let n = 0; n < 100; n++) assert.throws(() => reserveSubscription(identity(t), `replacement-${n}`), /capacity/);
	assert.equal(admitted.reduce((n, r) => n + r.records.length, 0), 128);
	assert.equal(admitted.reduce((n, r) => n + r.records.reduce((bytes, record) => bytes + record.capture!.bytes, 0), 0), 8 * 1024 * 1024);
	for (const [n, r] of admitted.entries()) {
		assert.equal(r.records[0], original[n]); // reload/recovery use these references, not copies
		assert.equal(r.beginCheck(), false);
		r.abandonUnsent(); // explicit cancellation cannot retract sent records
		assert.equal(r.records.length, 1);
		assert.equal(r.confirm(original[n].completionId), true);
		assert.equal(r.confirm(original[n].completionId), false);
	}
	assert.equal(subscriptionReservations().size, 0);
});

test("manager serializes immutable matches by receipt, retains terminal data beyond pruning", async t => {
	const dir = tempDir(t);
	const records: any[] = [];
	const manager = new JobManager({ logRoot: dir, env: {}, keepFinished: 0, killGraceMs: 10, drainMs: 10,
		onTerminal: () => assert.fail("subscription used ordinary terminal callback"),
		onSubscription: (record, reservation) => records.push({ record, reservation }),
	});
	t.after(async () => { await manager.shutdown(); manager.reconcileSubscriptions(); });
	const job = manager.subscribe({ sessionId: "full-session", lane: "L1", inboxDir: dir, cwd: dir,
		check: "printf immutable", timeoutSeconds: 0.25, intervalSeconds: 0.01, checkTimeoutSeconds: 1 });
	await waitFor(() => records.length === 1);
	assert.equal(records[0].record.event, "match");
	assert.equal(records[0].record.payload.status, "running");
	await new Promise(r => setTimeout(r, 35));
	assert.equal(manager.get(job.id)?.checks, 1);
	records[0].reservation.confirm(records[0].record.completionId);
	await waitFor(() => records.length === 2);
	assert.notEqual(records[0].record.completionId, records[1].record.completionId);
	assert.equal(records[1].record.sequence, 2);
	await waitFor(() => records.length === 3);
	assert.equal(records[2].record.event, "terminal");
	assert.equal(manager.get(job.id)?.status, "timed_out");
	assert.equal(manager.list().length, 1);
	assert.equal(records[1].reservation.records.length, 2);
	await manager.kill(job.id);
	assert.equal(subscriptionReservations().size, 0);
});

test("manager gates checks while parked and stops on invalid status or truncation", async t => {
	for (const mode of ["parked", "invalid", "truncated"] as const) {
		const dir = tempDir(t);
		mkdirSync(join(dir, "status"));
		if (mode !== "truncated") writeFileSync(join(dir, "status/L1.status"), mode === "parked" ? 'parked "owner" until 2020-01-01T00:00:00Z\n' : "bad");
		const records: any[] = [];
		const manager = new JobManager({ logRoot: dir, env: {}, checkOutputBytes: 4, killGraceMs: 10, drainMs: 10,
			onTerminal: () => assert.fail("ordinary completion"), onSubscription: r => records.push(r) });
		t.after(async () => { await manager.shutdown(); manager.reconcileSubscriptions(); });
		const job = manager.subscribe({ sessionId: "session", lane: "L1", inboxDir: dir, cwd: dir,
			check: "printf abcdef", timeoutSeconds: 0.1, intervalSeconds: 0.01, checkTimeoutSeconds: 1 });
		await waitFor(() => manager.get(job.id)?.status !== "running");
		assert.equal(manager.get(job.id)?.checks, mode === "truncated" ? 1 : 0);
		assert.equal(manager.get(job.id)?.status, mode === "parked" ? "timed_out" : "failed");
		assert.ok(records.length >= 1);
		if (mode === "truncated") assert.equal(records[0].capture.truncated, true);
		await manager.kill(job.id);
	}
});

function deliveryFixture(t: Parameters<typeof tempDir>[0]) {
	let parked = false;
	const sends: { id: string; items: Completion<string>[] }[] = [];
	const reservation = reserveSubscription(identity(t), "session");
	t.after(() => reservation.reconcile());
	const captured = record(1);
	reservation.retain(captured);
	const item: Completion<string> = { completionId: captured.completionId, payload: "subscription", subscription: {
		record: captured, retained: () => reservation.records.includes(captured), eligible: () => !parked,
		sent: () => reservation.markSent(captured.completionId), confirm: () => { reservation.confirm(captured.completionId); },
	} };
	const host = { isIdle: () => true, aborted: () => false, send: (id: string, items: Completion<string>[]) => sends.push({ id, items }) };
	const delivery = new Delivery(host);
	reservation.onDiscard = () => delivery.pruneSubscriptions();
	t.after(() => delivery.dispose());
	return { reservation, captured, item, host, delivery, sends, park: (value: boolean) => parked = value };
}

test("subscription idle window is fixed; urgent jobs bypass it and piggyback eligible matches", async t => {
	const f = deliveryFixture(t);
	f.delivery.add(f.item);
	await sleep(100);
	assert.equal(f.sends.length, 0);
	f.delivery.add({ completionId: "urgent", payload: "ordinary" });
	assert.equal(f.sends.length, 1);
	assert.equal(f.sends[0].items.length, 2);
	assert.equal(f.reservation.records[0], f.captured);
	f.delivery.confirm(f.sends[0].id);
	assert.equal(f.reservation.records.length, 0);
	f.delivery.confirm(f.sends[0].id);
	await sleep(200);
	assert.equal(f.sends.length, 1);
});

test("fixed window sends once without an urgent completion", async t => {
	const f = deliveryFixture(t);
	f.delivery.add(f.item);
	await sleep(150);
	assert.equal(f.sends.length, 0);
	await sleep(140);
	assert.equal(f.sends.length, 1);
	assert.equal(f.reservation.records.length, 1);
});

test("parked records gate idle, follow-up, settled, busy end, recovery and rebind; ordinary stays urgent", async t => {
	const f = deliveryFixture(t);
	f.park(true);
	f.delivery.add(f.item);
	f.delivery.onAgentStart();
	f.delivery.onAgentEnd();
	f.delivery.onAgentSettled();
	f.delivery.onBusyEnd(true);
	f.delivery.onBusyEnd(false);
	f.delivery.suspend();
	f.delivery.rebind(f.host);
	await sleep(280);
	assert.equal(f.sends.length, 0);
	f.delivery.add({ completionId: "urgent", payload: "ordinary" });
	assert.equal(f.sends.length, 1);
	assert.equal(f.sends[0].items[0].payload, "ordinary");
	f.park(false);
	f.delivery.onAgentStart();
	f.delivery.onAgentEnd();
	assert.equal(f.sends.length, 2);
	f.park(true);
	f.delivery.onAgentSettled();
	f.delivery.onBusyEnd(true);
	await sleep(270);
	assert.equal(f.sends.length, 2);
	f.delivery.suspend();
	f.delivery.rebind(f.host);
	await sleep(20);
	assert.equal(f.sends.length, 2);
	f.park(false);
	f.delivery.onAgentStart();
	f.delivery.onAgentEnd();
	assert.equal(f.sends.length, 3);
	assert.equal(f.sends[2].items[0], f.item);
	f.delivery.onAgentSettled();
	assert.equal(f.sends.length, 3);
	assert.equal(f.reservation.records.length, 1);
	f.delivery.confirm(f.sends[1].id);
	assert.equal(f.reservation.records.length, 0);
	f.delivery.confirm(f.sends[2].id);
});

test("suspend cancels idle timer and rebind keeps the original deadline", async t => {
	const f = deliveryFixture(t);
	f.delivery.add(f.item);
	await sleep(100);
	f.delivery.suspend();
	await sleep(200);
	assert.equal(f.sends.length, 0);
	f.delivery.rebind(f.host);
	await sleep(20);
	assert.equal(f.sends.length, 1);
});

test("permanent host failure reports retained subscription once and never retries", async t => {
	const f = deliveryFixture(t);
	let lost = 0;
	f.delivery.rebind({ ...f.host, isIdle: () => { throw new Error("stale"); }, lost: () => lost++ });
	f.delivery.onAgentStart();
	f.delivery.add(f.item);
	f.delivery.onAgentEnd();
	f.delivery.onAgentSettled();
	await sleep(20);
	assert.equal(lost, 1);
	assert.equal(f.reservation.records.length, 1);
	f.delivery.onBusyEnd(true);
	f.delivery.onAgentSettled();
	assert.equal(lost, 1);
});

test("128 full capture slots stay bounded through queued recovery, parked expiry churn and pruning", async t => {
	let parked = false;
	const batches: { id: string; items: Completion<string>[] }[] = [];
	const host = { isIdle: () => true, aborted: () => false, send: (id: string, items: Completion<string>[]) => batches.push({ id, items }) };
	const delivery = new Delivery(host);
	t.after(() => delivery.dispose());
	delivery.onAgentStart();
	const owners = Array.from({ length: 64 }, (_, n) => reserveSubscription(identity(t, `L${n}`), `session-${n}`));
	t.after(() => owners.forEach(r => r.reconcile()));
	const originals = owners.flatMap((owner, n) => {
		owner.onDiscard = () => delivery.pruneSubscriptions();
		const records = [record(n), record(n, "terminal")];
		owner.retain(records[0]); owner.retire(records[1]);
		return records.map(captured => {
			const item: Completion<string> = { completionId: captured.completionId, payload: "captured", subscription: {
				record: captured, retained: () => owner.records.includes(captured), eligible: () => !parked,
				sent: () => owner.markSent(captured.completionId), confirm: () => { owner.confirm(captured.completionId); },
			} };
			delivery.add(item);
			return item;
		});
	});
	delivery.onAgentEnd();
	assert.equal(batches[0].items.length, 128);
	parked = true;
	delivery.onAgentSettled();
	delivery.suspend(); delivery.rebind(host);
	await sleep(20);
	for (let n = 0; n < 100; n++) assert.throws(() => reserveSubscription(identity(t), "replacement"), /capacity/);
	assert.equal(owners.flatMap(r => r.records).reduce((sum, r) => sum + r.capture!.bytes, 0), 8 * 1024 * 1024);
	assert.equal(delivery.heldCount, 128);
	parked = false;
	delivery.onAgentStart(); delivery.onAgentEnd(); delivery.onAgentSettled();
	assert.equal(batches.length, 2);
	assert.equal(batches[1].items.length, 128);
	for (let n = 0; n < 128; n++) assert.equal(batches[1].items[n], originals[n]);
	delivery.confirm(batches[1].id);
	delivery.confirm(batches[0].id);
	assert.equal(subscriptionReservations().size, 0);
	assert.equal(delivery.heldCount, 0);
	for (let n = 0; n < 100; n++) {
		const owner = reserveSubscription(identity(t), "replacement");
		owner.onDiscard = () => delivery.pruneSubscriptions();
		const captured = record(n);
		owner.retain(captured);
		delivery.onAgentStart();
		delivery.add({ completionId: captured.completionId, payload: "unsent", subscription: {
			record: captured, retained: () => owner.records.includes(captured), eligible: () => false,
			sent: () => owner.markSent(captured.completionId), confirm: () => { owner.confirm(captured.completionId); },
		} });
		owner.abandonUnsent();
		assert.equal(delivery.heldCount, 0);
		assert.equal(subscriptionReservations().size, 0);
	}
});

test("enqueue and log write failures retain capture, stop production and remain discoverable", async t => {
	for (const mode of ["enqueue", "log"] as const) {
		const dir = tempDir(t);
		const manager = new JobManager({ logRoot: dir, env: {}, keepFinished: 0, killGraceMs: 10, drainMs: 10, onTerminal: () => assert.fail("ordinary"),
			onSubscription: () => { if (mode === "enqueue") throw new Error("injected enqueue failure"); } });
		t.after(async () => { await manager.shutdown(); manager.reconcileSubscriptions(); });
		let restore: (() => void) | undefined;
		if (mode === "log") {
			const original = LogWriter.prototype.write;
			const mocked = t.mock.method(LogWriter.prototype, "write", function(this: LogWriter, data: Buffer | string) {
				if (Buffer.isBuffer(data)) this.error = "injected log failure";
				else original.call(this, data);
			});
			restore = () => mocked.mock.restore();
		}
		const job = manager.subscribe({ sessionId: "session", lane: "L1", inboxDir: dir, cwd: dir, check: "printf CAPTURED",
			intervalSeconds: 0.01, timeoutSeconds: 5, checkTimeoutSeconds: 1 });
		await waitFor(() => manager.get(job.id)?.status === "failed");
		restore?.();
		const owner = [...subscriptionReservations().values()].find(r => r.snapshot?.logPath === job.logPath)!;
		assert.equal(owner.records.length, 2);
		assert.equal(Buffer.from(owner.records[0].capture!.data, "latin1").toString(), "CAPTURED");
		assert.match(manager.get(job.id)!.error!, mode === "enqueue" ? /enqueue/ : /log failure/);
		await sleep(50);
		assert.equal(manager.list()[0].checks, 1);
		await manager.kill(job.id);
		assert.equal(subscriptionReservations().size, 0);
	}
});

test("retired stale and expired handoff records remain discoverable after manager replacement", async t => {
	for (const expire of [false, true]) {
		const dir = tempDir(t);
		const sessionId = crypto.randomUUID();
		const manager = new JobManager({ logRoot: dir, env: {}, keepFinished: 0, killGraceMs: 10, drainMs: 10, onTerminal: () => {} });
		manager.bindSession(sessionId);
		const delivery = new Delivery<JobSnapshot>({ isIdle: () => false, aborted: () => false, send: () => assert.fail("stale send") });
		const owner: Owner = { version: 2, manager, delivery, token: expire ? undefined : {}, alive: () => false };
		sessionOwners().set(sessionId, owner);
		t.after(async () => { sessionOwners().delete(sessionId); await manager.shutdown(); manager.reconcileSubscriptions(); });
		const job = manager.subscribe({ sessionId, lane: "L1", inboxDir: dir, cwd: dir, check: "printf RETAINED",
			intervalSeconds: 0.01, timeoutSeconds: 5, checkTimeoutSeconds: 1 });
		await waitFor(() => manager.get(job.id)?.matchSequence === 1);
		if (expire) expireReloadOwner(sessionId, owner, 5);
		else await stopOrphans();
		await waitFor(() => manager.get(job.id)?.status === "failed");
		const fresh = new JobManager({ logRoot: dir, env: {}, onTerminal: () => {} });
		fresh.bindSession(sessionId);
		assert.equal(fresh.list()[0].id, job.id);
		assert.equal(fresh.get(job.id)!.status, "failed");
		assert.throws(() => fresh.subscribe({ sessionId, lane: "L1", inboxDir: dir, cwd: dir, check: "touch must-not-consume",
			intervalSeconds: 0.01, timeoutSeconds: 5, checkTimeoutSeconds: 1 }), /reserved/);
		assert.equal(existsSync(join(dir, "must-not-consume")), false);
		await fresh.kill(job.id);
		const next = fresh.start({ command: "true", cwd: dir, timeoutSeconds: 1 });
		assert.equal(next.id, "j2");
		await fresh.shutdown();
		assert.equal(subscriptionReservations().size, 0);
	}
});

test("parked expiry retains match and terminal through replacement attempts and finished pruning", async t => {
	const dir = tempDir(t);
	const manager = new JobManager({ logRoot: dir, env: {}, keepFinished: 0, killGraceMs: 10, drainMs: 10, onTerminal: () => {} });
	t.after(async () => { await manager.shutdown(); manager.reconcileSubscriptions(); });
	const options = { sessionId: "session", lane: "L1", inboxDir: dir, cwd: dir, check: "printf PARKED-CAPTURE",
		intervalSeconds: 0.01, timeoutSeconds: 0.15, checkTimeoutSeconds: 1 };
	const job = manager.subscribe(options);
	await waitFor(() => manager.get(job.id)?.matchSequence === 1);
	mkdirSync(join(dir, "status"));
	writeFileSync(join(dir, "status/L1.status"), 'parked "owner" until 2020-01-01T00:00:00Z\n');
	await waitFor(() => manager.get(job.id)?.status === "timed_out");
	for (let n = 0; n < 100; n++) assert.throws(() => manager.subscribe({ ...options, check: "touch must-not-consume", label: String(n) }), /reserved/);
	assert.equal(manager.list().length, 1);
	assert.equal(manager.get(job.id)!.checks, 1);
	const owner = [...subscriptionReservations().values()].find(r => r.snapshot?.logPath === job.logPath)!;
	assert.equal(owner.records.length, 2);
	assert.equal(Buffer.from(owner.records[0].capture!.data, "latin1").toString(), "PARKED-CAPTURE");
	assert.equal(existsSync(join(dir, "must-not-consume")), false);
	await manager.kill(job.id);
	assert.equal(subscriptionReservations().size, 0);
});

test("subscription failures, silent in-flight cancellation and frozen settings fence future checks", async t => {
	for (const mode of ["exit", "timeout", "kill", "freeze"] as const) {
		const dir = tempDir(t);
		const events: any[] = [];
		const env = { MARKER: "ORIGINAL" };
		const manager = new JobManager({ logRoot: dir, env, killGraceMs: 10, drainMs: 10, onTerminal: () => assert.fail("ordinary"),
			onSubscription: (record, owner) => events.push({ record, owner }) });
		t.after(async () => { await manager.shutdown(); manager.reconcileSubscriptions(); });
		const options = { sessionId: "session", lane: "L1", inboxDir: dir, cwd: dir,
			check: mode === "exit" ? "printf ERROR; exit 2" : mode === "freeze" ? 'printf "$MARKER"' : "sleep 10; touch must-not-consume",
			intervalSeconds: 0.01, timeoutSeconds: 5, checkTimeoutSeconds: mode === "timeout" ? 0.05 : 1 };
		const job = manager.subscribe(options);
		if (mode === "kill") {
			await manager.kill(job.id);
			assert.equal(events.length, 0);
			assert.equal(subscriptionReservations().size, 0);
		} else if (mode === "freeze") {
			await waitFor(() => events.length === 1);
			env.MARKER = "CHANGED"; options.check = "touch must-not-consume";
			events[0].owner.confirm(events[0].record.completionId);
			await waitFor(() => events.length === 2);
			assert.equal(Buffer.from(events[1].record.capture.data, "latin1").toString(), "ORIGINAL");
			await manager.kill(job.id);
		} else {
			await waitFor(() => manager.get(job.id)?.status === "failed");
			assert.equal(events.length, 1);
			assert.equal(events[0].record.event, "terminal");
			assert.equal(manager.get(job.id)!.checks, 1);
			await manager.kill(job.id);
		}
		assert.equal(existsSync(join(dir, "must-not-consume")), false);
	}
});

test("receipt backpressure and in-flight fencing release exactly once", t => {
	const r = reserveSubscription(identity(t), "session");
	t.after(() => r.reconcile());
	assert.equal(r.beginCheck(), true);
	assert.equal(r.beginCheck(), false);
	const match = record(1);
	r.retain(match);
	r.endCheck();
	assert.equal(r.beginCheck(), false);
	assert.equal(r.confirm(match.completionId), true);
	assert.equal(r.beginCheck(), true);
	r.retire();
	assert.ok(subscriptionReservations().has(r.key));
	r.endCheck();
	assert.equal(subscriptionReservations().has(r.key), false);
});
