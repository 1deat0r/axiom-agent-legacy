import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Session stall watchdog knobs and the RLM child liveness classifier
 * (ADR-0067).
 *
 * Two watchdogs share this module's vocabulary:
 * - The stream stall watchdog lives in the agent loop (`streamStallTimeoutMs`
 *   / `streamStallMaxAttempts` on `AgentLoopConfig`); the env knobs here feed
 *   the `Agent` constructors in this package.
 * - The RLM child liveness check marks a running child `stalled` when its
 *   session dir has had no writes for `AXIOM_RLM_CHILD_STALL_MS`.
 *
 * Env values parse as non-negative integers; invalid values fall back to the
 * default so a typo can never crash the agent.
 */

export const STREAM_STALL_TIMEOUT_MS_ENV = "AXIOM_STREAM_STALL_TIMEOUT_MS";
export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 120_000;

export const STREAM_STALL_MAX_ATTEMPTS_ENV = "AXIOM_STREAM_STALL_MAX_ATTEMPTS";
export const DEFAULT_STREAM_STALL_MAX_ATTEMPTS = 2;

export const RLM_CHILD_STALL_MS_ENV = "AXIOM_RLM_CHILD_STALL_MS";
export const DEFAULT_RLM_CHILD_STALL_MS = 600_000;

/** Local harness state subdir inside a child session dir; its writes count as activity. */
const RLM_CHILD_HARNESS_DIR = "harness";

/** Non-negative integer env override with a fallback; never throws. */
function envInt(name: string, fallback: number, env: Record<string, string | undefined>): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** No-data threshold for provider streams; 0 disables the watchdog. */
export function resolveStreamStallTimeoutMs(env: Record<string, string | undefined> = process.env): number {
	return envInt(STREAM_STALL_TIMEOUT_MS_ENV, DEFAULT_STREAM_STALL_TIMEOUT_MS, env);
}

/** Total provider attempts (initial + retries) before a repeated stall fails the turn. */
export function resolveStreamStallMaxAttempts(env: Record<string, string | undefined> = process.env): number {
	return envInt(STREAM_STALL_MAX_ATTEMPTS_ENV, DEFAULT_STREAM_STALL_MAX_ATTEMPTS, env);
}

/** No-write threshold marking a running RLM child stalled; 0 disables. */
export function resolveRlmChildStallMs(env: Record<string, string | undefined> = process.env): number {
	return envInt(RLM_CHILD_STALL_MS_ENV, DEFAULT_RLM_CHILD_STALL_MS, env);
}

/**
 * Cadence for re-emitting child snapshots so live views pick up a stalled
 * child without waiting for child events (which a stalled child never sends).
 * Quarter of the threshold, clamped to [5s, 60s]; undefined when disabled.
 */
export function rlmChildStallRefreshMs(stallMs: number): number | undefined {
	if (stallMs <= 0) return undefined;
	return Math.min(Math.max(Math.floor(stallMs / 4), 5_000), 60_000);
}

/**
 * Newest mtime among a child session dir's direct files and its harness
 * subdir files, or undefined when the dir is missing, empty, or unreadable.
 * A missing dir is "no proof", never a stall.
 */
export function rlmChildSessionLastWriteMs(sessionDir: string): number | undefined {
	let newest: number | undefined;
	const consider = (path: string): void => {
		try {
			const stat = statSync(path);
			if (!stat.isFile()) return;
			const mtime = stat.mtimeMs;
			if (newest === undefined || mtime > newest) newest = mtime;
		} catch {
			// Racing the child's writes is fine; the next sweep re-reads.
		}
	};
	let entries: string[];
	try {
		entries = readdirSync(sessionDir);
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		consider(join(sessionDir, entry));
	}
	try {
		for (const entry of readdirSync(join(sessionDir, RLM_CHILD_HARNESS_DIR))) {
			consider(join(sessionDir, RLM_CHILD_HARNESS_DIR, entry));
		}
	} catch {
		// No harness dir yet; the session files are the whole signal.
	}
	return newest;
}

/**
 * True when the child session dir has had no writes for `stallMs`, false
 * otherwise. Disabled (`stallMs <= 0`) and no-proof cases are never stalled.
 */
export function isRlmChildStalled(sessionDir: string, nowMs: number, stallMs: number): boolean {
	if (stallMs <= 0) return false;
	const lastWrite = rlmChildSessionLastWriteMs(sessionDir);
	if (lastWrite === undefined) return false;
	return nowMs - lastWrite >= stallMs;
}
