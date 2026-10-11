import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-jobs-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise(r => setTimeout(r, 25));
	}
}

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function readPid(path: string): number {
	return Number(readFileSync(path, "utf8").trim());
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
