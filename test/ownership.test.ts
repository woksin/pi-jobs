import { test } from "node:test";
import assert from "node:assert/strict";
import { compatibleOwner, expireReloadOwner, highestJobId, sessionOwners, stopOrphans, takeReloadOwner, type Owner } from "../src/ownership.ts";

test("history high-water mark includes lists, old result text and completions, not other tools", () => {
	const entry = (message: any) => ({ type: "message", message });
	assert.equal(highestJobId([
		entry({ role: "toolResult", toolName: "job_list", details: { jobs: [{ id: "j31" }] } }),
		entry({ role: "toolResult", toolName: "job_watch", content: [{ text: "Started watch j471: wait" }] }),
		{ type: "custom_message", customType: "pi-jobs", details: { completions: [{ job: { id: "j544" } }] } },
		entry({ role: "toolResult", toolName: "Agent", details: { id: "j9999" } }),
	]), 544);
});

test("unknown owner and reload handoff are not proof of an orphan", async () => {
	let stopped = 0;
	const owner = (alive: () => boolean | undefined, token: object | undefined): Owner => ({
		version: 2, alive, token,
		manager: { shutdown: async () => { stopped++; }, list: () => [{ status: "running" }] } as any,
		delivery: { dispose: () => { stopped++; } } as any,
	});
	const owners = new Map([
		["live", owner(() => true, {})],
		["unknown", owner(() => undefined, {})],
		["reload", owner(() => false, undefined)],
	]);
	assert.deepEqual(await stopOrphans(owners), []);
	assert.equal(stopped, 0);
	assert.equal(owners.size, 3);
});


function handoffOwner(): Owner {
	const noop = () => {};
	return {
		version: 2, alive: () => undefined,
		manager: Object.fromEntries(["start", "watch", "get", "list", "output", "kill", "shutdown", "killAllSync", "advanceSequence", "notificationTail"].map(name => [name, noop])) as any,
		delivery: Object.fromEntries(["add", "suspend", "rebind", "dispose", "onAgentStart", "onAgentEnd", "onAgentSettled", "onBusyEnd", "confirm"].map(name => [name, noop])) as any,
	};
}

test("reload timeout is unref'd, stops abandoned work and logs its owner", async t => {
	const owner = handoffOwner(), owners = new Map([["abandoned", owner]]);
	let stopped = 0;
	owner.manager.shutdown = async () => { stopped++; };
	const warnings: string[] = [];
	t.mock.method(console, "warn", (text: string) => warnings.push(text));
	expireReloadOwner("abandoned", owner, 10, owners);
	t.after(() => clearTimeout(owner.reloadTimer));
	assert.equal(owner.reloadTimer!.hasRef(), false);
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(stopped, 1);
	assert.equal(owners.has("abandoned"), false);
	assert.match(warnings[0], /abandoned.*expired.*stopping/);
});

test("compatible adoption cancels handoff expiry", async t => {
	const owner = handoffOwner(), owners = sessionOwners();
	let stopped = false;
	owner.manager.shutdown = async () => { stopped = true; };
	owners.set("adopted", owner);
	t.after(() => { owners.delete("adopted"); clearTimeout(owner.reloadTimer); });
	expireReloadOwner("adopted", owner, 10);
	assert.equal((await takeReloadOwner("adopted")).owner, owner);
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(stopped, false);
});

test("incompatible and legacy suspended owners are stopped, never adopted", async t => {
	const global = globalThis as any, legacyKey = Symbol.for("pi-jobs.sessionOwners.v1"), saved = global[legacyKey];
	const legacy = handoffOwner(), malformed = handoffOwner();
	delete (legacy as any).version;
	delete (malformed.delivery as any).rebind;
	let stopped = 0;
	for (const owner of [legacy, malformed]) owner.manager.shutdown = async () => { stopped++; };
	global[legacyKey] = new Map([["legacy", legacy]]);
	const owners = sessionOwners();
	owners.set("malformed", malformed);
	t.after(() => { owners.delete("malformed"); if (saved === undefined) delete global[legacyKey]; else global[legacyKey] = saved; });
	assert.equal(compatibleOwner(malformed), false);
	assert.equal((await takeReloadOwner("legacy")).incompatible, true);
	assert.equal((await takeReloadOwner("malformed")).incompatible, true);
	assert.equal(stopped, 2);
	assert.equal(global[legacyKey].size, 0);
	assert.equal(owners.has("malformed"), false);
});
