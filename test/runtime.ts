import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve a local dependency first, then Pi's standard user installation locations. */
export function runtimeDirectory(): string | undefined {
	if (process.env.PI_RUNTIME_DIR) return resolve(process.env.PI_RUNTIME_DIR);
	try {
		return dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	} catch { /* A peer supplied by the host need not be a local dependency. */ }
	const packagePath = "node_modules/@earendil-works/pi-coding-agent";
	return [
		join(homedir(), ".local", "share", "pi-runtime", "lib", packagePath),
		join(homedir(), ".pi", "agent", "npm", packagePath),
	].find(directory => existsSync(join(directory, "dist/index.js")));
}

/** Locate pi-ai's entry: nested under the runtime (global installs) or hoisted next to it (local devDependency installs). */
export function piAiEntry(runtime: string | undefined): string | undefined {
	if (!runtime) return undefined;
	const candidates = [
		join(runtime, "node_modules/@earendil-works/pi-ai/dist/index.js"),
		join(dirname(dirname(runtime)), "@earendil-works/pi-ai/dist/index.js"),
	];
	return candidates.find(existsSync);
}
