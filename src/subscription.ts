/** Opt-in inbox policy; no Pi APIs and no consuming filesystem operations. */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import type { JobSnapshot } from "./jobs.ts";
import type { RunOutcome } from "./supervisor.ts";

export const SUBSCRIPTION_OWNERS = 64;
export const RECORD_BYTES = 64 * 1024;
export const IDLE_WINDOW_MS = 250;
const STATUS_BYTES = 512;
const LANE = /^[A-Z][A-Z0-9-]{0,15}$/;

export interface SubscriptionIdentity {
	readonly lane: string;
	readonly inboxDir: string;
	readonly statusPath: string;
}

export interface ImmutableCapture {
	/** Byte-preserving immutable string, not UTF-8 display text. */
	readonly data: string;
	readonly bytes: number;
	readonly truncated: boolean;
}

/** Both delivery slots refer to these same objects through queue/recovery/reload. */
export interface SubscriptionRecord {
	readonly completionId: string;
	readonly payload: Readonly<JobSnapshot>;
	readonly event: "match" | "terminal";
	readonly sequence: number;
	readonly capture?: ImmutableCapture;
}

export function captureOutput(bytes: Buffer, truncated = false): ImmutableCapture {
	return Object.freeze({ data: bytes.subarray(0, RECORD_BYTES).toString("latin1"),
		bytes: Math.min(bytes.length, RECORD_BYTES), truncated: truncated || bytes.length > RECORD_BYTES });
}

export function captureText(capture: ImmutableCapture): string {
	return Buffer.from(capture.data, "latin1").toString("utf8");
}

export function classifyInboxExit(outcome: RunOutcome, timedOut = false): "match" | "quiet" | "failure" {
	if (timedOut || outcome.error || outcome.signal) return "failure";
	return outcome.exitCode === 0 ? "match" : outcome.exitCode === 1 ? "quiet" : "failure";
}

function validateLane(lane: string, env: NodeJS.ProcessEnv): void {
	if (!LANE.test(lane)) throw new Error("lane must match ^[A-Z][A-Z0-9-]{0,15}$.");
	for (const known of [env.PI_LANE_ID, env.PI_ORCH_ID]) {
		if (known && known !== lane) throw new Error(`Declared lane ${lane} conflicts with known lane ${known}.`);
	}
}

export function declaredIdentity(options: { inboxDir: string; lane: string; cwd: string; env: NodeJS.ProcessEnv }): SubscriptionIdentity {
	validateLane(options.lane, options.env);
	if (typeof options.inboxDir !== "string" || !options.inboxDir.trim()) throw new Error("inboxDir must name an existing directory.");
	const inboxDir = realpathSync(resolve(options.cwd, options.inboxDir));
	if (!statSync(inboxDir).isDirectory()) throw new Error("inboxDir must name an existing directory.");
	const statusDir = options.env.LANE_STATUS_DIR ? resolve(options.cwd, options.env.LANE_STATUS_DIR) : join(inboxDir, "status");
	return Object.freeze({ lane: options.lane, inboxDir, statusPath: join(statusDir, `${options.lane}.status`) });
}

export type LaneStatus = { state: "eligible" | "parked" | "invalid"; diagnostic?: string };

function validTime(value: string): boolean {
	if (!/^\d{4}-\d\d-\d\dT\S+$/.test(value)) return false;
	if (!Number.isFinite(Date.parse(value))) return false;
	if (Number(value.slice(11, 13)) > 23) return false;
	const midnight = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
	return Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === value.slice(0, 10);
}

function parseStatus(line: string): LaneStatus {
	const working = /^working since (\S+)$/.exec(line);
	const closed = /^closed reassigned-to ([A-Z][A-Z0-9-]{0,15}) at (\S+)(?: reason "[^"\r\n]*")?$/.exec(line);
	if (working && validTime(working[1])) return { state: "eligible" };
	if (closed && validTime(closed[2])) return { state: "eligible" };
	const blocked = /^(parked|waiting-on|barred-by) "[^"\r\n]*" until (\S+)$/.exec(line);
	if (!blocked || !validTime(blocked[2])) throw new Error("malformed lane status");
	// Waiting/barred and closed are not parked; assessment time never unparks a parked lane.
	return { state: blocked[1] === "parked" ? "parked" : "eligible" };
}

function readStatus(fd: number): LaneStatus {
	const stat = fstatSync(fd);
	if (!stat.isFile() || stat.size > STATUS_BYTES) throw new Error("lane status must be a regular file of at most 512 bytes");
	const buffer = Buffer.alloc(STATUS_BYTES + 1);
	const length = readSync(fd, buffer, 0, buffer.length, 0);
	if (length > STATUS_BYTES) throw new Error("lane status exceeds 512 bytes");
	return parseStatus(buffer.subarray(0, length).toString("utf8").replace(/\r?\n$/, ""));
}

/** Non-blocking open plus fstat prevents FIFO/device hangs; read at most 513 bytes. */
export function laneStatus(identity: SubscriptionIdentity): LaneStatus {
	let fd: number | undefined;
	try {
		fd = openSync(identity.statusPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
		return readStatus(fd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "eligible" };
		return { state: "invalid", diagnostic: `Cannot read a valid status for ${identity.lane}: ${String(error).slice(0, 512)}` };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
