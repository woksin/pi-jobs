/** Log directory layout and retention. */
import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export const RETENTION_DAYS = 7;
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;

/** `$PI_JOBS_DIR`, else `~/.pi/agent/jobs`. Logs go to `<root>/<YYYY-MM-DD>/<HHMMSS>-<session tag>-<id>.log`. */
export function defaultLogRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_JOBS_DIR || join(homedir(), ".pi", "agent", "jobs");
}

/** True when `path` resolves (symlinks followed) to a location strictly inside `root`. */
function resolvesInside(path: string, root: string): boolean {
	try {
		return realpathSync(path).startsWith(root + sep);
	} catch {
		return false;
	}
}

/**
 * Delete `*.log` files older than `maxAgeMs` (by mtime) inside `<root>/<YYYY-MM-DD>/`, then
 * remove day directories left empty. Touches nothing else: symlinked day directories and
 * symlinked files are skipped, and every path must resolve inside the log root.
 * Returns the number of files deleted.
 */
export function pruneLogs(root: string, maxAgeMs = RETENTION_DAYS * 86_400_000, now = Date.now()): number {
	let removed = 0;
	let days: string[];
	let realRoot: string;
	try {
		realRoot = realpathSync(root);
		days = readdirSync(realRoot);
	} catch {
		return 0;
	}
	for (const day of days) {
		if (!DAY_DIR.test(day)) continue;
		const dir = join(realRoot, day);
		try {
			if (!lstatSync(dir).isDirectory() || !resolvesInside(dir, realRoot)) continue;
		} catch {
			continue;
		}
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		let left = files.length;
		for (const file of files) {
			if (!file.endsWith(".log")) continue;
			const path = join(dir, file);
			try {
				const st = lstatSync(path);
				if (st.isFile() && now - st.mtimeMs > maxAgeMs && resolvesInside(path, realRoot)) {
					unlinkSync(path);
					removed++;
					left--;
				}
			} catch {}
		}
		if (left === 0) {
			try {
				rmdirSync(dir);
			} catch {}
		}
	}
	return removed;
}
