// RPC driver for pi-jobs end-to-end scenarios: runs `pi --mode rpc` and records its events.
import { execFileSync, spawn } from "node:child_process";

const MODEL = "anthropic/claude-haiku-4-5";

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Pi {
	constructor(cwd) {
		this.t0 = Date.now();
		this.events = [];
		this.stderr = "";
		this.exitInfo = undefined;
		let buf = "";
		this.p = spawn("pi", ["--mode", "rpc", "--no-session", "--model", MODEL], { cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.pid = this.p.pid;
		this.p.stderr.on("data", d => (this.stderr += d));
		this.p.stdout.on("data", d => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				try {
					const e = JSON.parse(line);
					e._t = this.now();
					this.events.push(e);
				} catch {}
			}
		});
		this.exited = new Promise(r => this.p.on("exit", (code, signal) => r((this.exitInfo = { code, signal, t: this.now() }))));
	}

	now() {
		return (Date.now() - this.t0) / 1000;
	}

	send(o) {
		this.p.stdin.write(JSON.stringify(o) + "\n");
	}

	prompt(message) {
		this.send({ type: "prompt", message });
	}

	/** First event matching `pred` at index >= `from`, or null after `ms`. */
	async waitFor(pred, ms, from = 0) {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			const e = this.events.slice(from).find(pred);
			if (e) return e;
			await sleep(100);
		}
		return null;
	}

	/** The next agent_settled after event index `from`, or null. */
	settled(ms, from = 0) {
		return this.waitFor(e => e.type === "agent_settled", ms, from);
	}

	tools() {
		return this.events.filter(e => e.type === "tool_execution_start").map(e => ({ t: e._t, name: e.toolName, args: e.args }));
	}

	/** Completion messages, with their content parts joined. */
	completions() {
		return this.events
			.filter(e => e.type === "message_end" && e.message?.role === "custom")
			.map(e => {
				const c = e.message.content;
				return { t: e._t, text: typeof c === "string" ? c : c.map(p => p.text ?? "").join("") };
			});
	}

	assistantTexts() {
		return this.events
			.filter(e => e.type === "message_end" && e.message?.role === "assistant")
			.map(e => e.message.content.filter(c => c.type === "text").map(c => c.text).join(""))
			.filter(Boolean);
	}

	cost() {
		return this.events.reduce((sum, e) => sum + (e.type === "message_end" ? (e.message?.usage?.cost?.total ?? 0) : 0), 0);
	}

	kill() {
		try {
			this.p.kill("SIGKILL");
		} catch {}
	}
}

/**
 * Processes that belong to this run: their command line contains `marker`, a per-run random
 * token placed in argv[0] of the job's long-running process (`exec -a <marker> sleep …`).
 * Nothing else on the system can match it.
 */
export function owned(marker) {
	const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
	return out
		.split("\n")
		.filter(l => l.includes(marker))
		.map(l => ({ pid: Number(l.trim().split(/\s+/)[0]), command: l.trim() }));
}

export function killOwned(marker) {
	for (const { pid } of owned(marker)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}
