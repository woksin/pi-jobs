/** Size-capped, error-recording log file writer. */
import { closeSync, openSync, writeSync } from "node:fs";

export const DEFAULT_LOG_CAP_BYTES = 50 * 1024 * 1024;

function formatBytes(n: number): string {
	return n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`;
}

export class LogWriter {
	readonly path: string;
	readonly capBytes: number;
	bytes = 0;
	truncated = false;
	/** First write error; writing stops after it, the job keeps running. */
	error: string | undefined;
	private fd: number | undefined;

	/** Throws if the file cannot be opened. */
	constructor(path: string, capBytes = DEFAULT_LOG_CAP_BYTES) {
		this.path = path;
		this.capBytes = capBytes;
		this.fd = openSync(path, "a");
	}

	write(data: Buffer | string): void {
		if (this.fd === undefined || this.truncated) return;
		let buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		const room = this.capBytes - this.bytes;
		let cut = false;
		if (buf.length > room) {
			buf = buf.subarray(0, Math.max(0, room));
			cut = true;
		}
		this.raw(buf);
		this.bytes += buf.length;
		if (cut && this.error === undefined) {
			this.truncated = true;
			this.raw(Buffer.from(`\n[pi-jobs: log truncated at ${formatBytes(this.capBytes)}; further output is discarded, the job keeps running]\n`));
		}
	}

	close(): void {
		if (this.fd === undefined) return;
		try {
			closeSync(this.fd);
		} catch {}
		this.fd = undefined;
	}

	private raw(buf: Buffer): void {
		if (this.fd === undefined) return;
		let off = 0;
		try {
			while (off < buf.length) off += writeSync(this.fd, buf, off, buf.length - off);
		} catch (err) {
			this.error = (err as Error).message;
			this.close();
		}
	}
}
