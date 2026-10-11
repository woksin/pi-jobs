/** Watch condition evaluation (pure). */

export type WatchUntil = "success" | "failure" | "change";

export interface CheckResult {
	/** Exit status from bash (128+n after signal n), or null if it was not reported. */
	exitCode: number | null;
	/** Signal observed directly (the check's supervisor was killed), else null. */
	signal: string | null;
	/** True when the check was cut short (per-check timeout, or the watch's timeout/kill). */
	timedOut: boolean;
	/** Display output: a bounded tail of the check's output. */
	output: string;
	/** Digest of the complete output streams; compared by until:"change" when present. */
	outputHash?: string;
}

export interface WatchEvaluation {
	matched: boolean;
	/** Fingerprint of the first conclusive check, used by `until: "change"`. */
	baseline: string | undefined;
}

/**
 * What `until: "change"` compares: exit status plus the digest of the complete output (exact
 * bytes), falling back to the trimmed display output when no digest is available.
 */
export function fingerprint(result: CheckResult): string {
	const out = result.outputHash ?? result.output.trim();
	return `${result.exitCode ?? result.signal}\u0000${out}`;
}

/**
 * Decide whether a check meets the watch condition.
 *  - A timed-out check is inconclusive: it never matches and never sets the baseline.
 *  - "success": the check exited 0.
 *  - "failure": the check exited non-zero or was killed by a signal.
 *  - "change": exit status or complete output differs from the first conclusive check.
 */
export function evaluateWatch(until: WatchUntil, result: CheckResult, baseline: string | undefined): WatchEvaluation {
	if (result.timedOut) return { matched: false, baseline };
	switch (until) {
		case "success":
			return { matched: result.exitCode === 0, baseline };
		case "failure":
			return { matched: result.exitCode !== 0, baseline };
		case "change": {
			const print = fingerprint(result);
			if (baseline === undefined) return { matched: false, baseline: print };
			return { matched: print !== baseline, baseline };
		}
	}
}
