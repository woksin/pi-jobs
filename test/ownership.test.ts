import { test } from "node:test";
import assert from "node:assert/strict";
import { highestJobId, stopOrphans, type Owner } from "../src/ownership.ts";

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
		alive, token,
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
