/**
 * Bounded output tails. Never reads more than `maxBytes` from a log file, so a multi-GB log
 * costs the same as a small one.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface Tail {
	text: string;
	/** True when earlier output (lines or bytes) was left out. */
	truncated: boolean;
}

// CSI/OSC escape sequences (colours, cursor movement, hyperlinks).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Remove ANSI escapes and collapse carriage-return progress redraws to their final state. */
export function cleanOutput(text: string): string {
	return text
		.replace(ANSI, "")
		.split("\n")
		.map(line => {
			const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
			const cr = trimmed.lastIndexOf("\r");
			return cr === -1 ? trimmed : trimmed.slice(cr + 1);
		})
		.join("\n");
}

/**
 * Last `maxLines` lines of `buf`, at most `maxBytes` bytes. `complete` says whether `buf`
 * starts at the beginning of the output (false when it is already a window of a larger file).
 */
export function tailBuffer(buf: Buffer, maxLines: number, maxBytes: number, complete = true): Tail {
	let truncated = !complete;
	let window = buf;
	if (window.length > maxBytes) {
		window = window.subarray(window.length - maxBytes);
		truncated = true;
	}
	let text = window.toString("utf8");
	if (truncated) {
		// The window probably starts mid-line (or mid-character): drop the partial first line
		// unless it is the only line we have.
		const nl = text.indexOf("\n");
		if (nl !== -1 && nl < text.length - 1) text = text.slice(nl + 1);
		else text = text.replace(/^\uFFFD+/, "");
	}
	text = cleanOutput(text).replace(/\n+$/, "");
	if (text === "") return { text, truncated };
	const lines = text.split("\n");
	if (lines.length > maxLines) {
		text = lines.slice(lines.length - maxLines).join("\n");
		truncated = true;
	}
	// Decoding can grow the text: each invalid byte becomes U+FFFD (3 bytes). Enforce the budget
	// on what is actually returned.
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		text = lastBytes(text, maxBytes);
		truncated = true;
	}
	return { text, truncated };
}

/** The longest suffix of `text` (whole code points) that fits in `maxBytes` UTF-8 bytes. */
export function lastBytes(text: string, maxBytes: number): string {
	let bytes = 0;
	let i = text.length;
	while (i > 0) {
		// Step back over a surrogate pair as one code point.
		const isLow = (text.charCodeAt(i - 1) & 0xfc00) === 0xdc00 && i >= 2 && (text.charCodeAt(i - 2) & 0xfc00) === 0xd800;
		const start = isLow ? i - 2 : i - 1;
		const size = Buffer.byteLength(text.slice(start, i), "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		i = start;
	}
	return text.slice(i);
}

export function tailText(text: string, maxLines: number, maxBytes: number): Tail {
	return tailBuffer(Buffer.from(text, "utf8"), maxLines, maxBytes);
}

/** Bounded tail of a file: reads only the last `maxBytes` bytes. Missing file → empty tail. */
export function readTail(path: string, maxLines: number, maxBytes: number): Tail {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return { text: "", truncated: false };
	}
	try {
		const size = fstatSync(fd).size;
		const n = Math.min(size, maxBytes);
		const buf = Buffer.alloc(n);
		let read = 0;
		while (read < n) {
			const got = readSync(fd, buf, read, n - read, size - n + read);
			if (got === 0) break;
			read += got;
		}
		return tailBuffer(buf.subarray(0, read), maxLines, maxBytes, n === size);
	} finally {
		closeSync(fd);
	}
}

/** Fixed-capacity byte sink that keeps only the most recent `capacity` bytes. */
export class TailSink {
	readonly capacity: number;
	private chunks: Buffer[] = [];
	private size = 0;
	dropped = false;

	constructor(capacity: number) {
		this.capacity = capacity;
	}

	push(chunk: Buffer): void {
		if (chunk.length > this.capacity) {
			// Only the end of an oversized chunk can survive; copy it so the large buffer is freed.
			chunk = Buffer.from(chunk.subarray(chunk.length - this.capacity));
			this.dropped = true;
		}
		this.chunks.push(chunk);
		this.size += chunk.length;
		while (this.size - this.chunks[0].length >= this.capacity) {
			this.size -= this.chunks.shift()!.length;
			this.dropped = true;
		}
		if (this.size > this.capacity) {
			// Trim the oldest chunk (copied, so its larger backing buffer can be freed).
			const excess = this.size - this.capacity;
			this.chunks[0] = Buffer.from(this.chunks[0].subarray(excess));
			this.size = this.capacity;
			this.dropped = true;
		}
	}

	/** Bytes currently held (never more than `capacity`). */
	get retainedBytes(): number {
		return this.size;
	}

	toBuffer(): Buffer {
		return Buffer.concat(this.chunks, this.size);
	}
}
