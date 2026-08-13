/**
 * Gateway session budget (streaming v2 follow-up): bounds how large a channel
 * session may grow before the gateway archives it and starts fresh. Without
 * this, every reply re-processes the whole history — a session that has grown
 * to hundreds of thousands of real tokens makes every answer take a minute or
 * more before the first word appears.
 *
 * The archive keeps the file searchable: it is renamed to
 * `<id>.jsonl.archived-<ts>`, and the search indexer accepts archived names,
 * so cross-session recall (/search, /sessions) survives the reset.
 */
import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionIdForChannel } from "./completion.js";

/**
 * Soft cap on a channel session file. 256KB of JSONL is roughly tens of
 * thousands of real tokens once code/tool payloads are counted — past this,
 * provider prefill dominates reply latency.
 */
export const GATEWAY_SESSION_BUDGET_BYTES = 256 * 1024;

/** The note shown when the gateway reset the channel session mid-reply. */
export const SESSION_RESET_NOTICE =
	"♻️ (session was getting long, so I archived it and started fresh — /search still finds the old one)";

/** The session file a channel's agent run reads/writes (deterministic id). */
export function sessionFilePath(sessionsDir: string, sessionKey: string): string {
	return join(sessionsDir, `${sessionIdForChannel(sessionKey)}.jsonl`);
}

/** Whether the session file exceeds the budget (missing = fresh, within budget). */
export function sessionExceedsBudget(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		return (statSync(path).size ?? 0) > GATEWAY_SESSION_BUDGET_BYTES;
	} catch {
		return false; // unreadable/racing: never block a reply on the budget check
	}
}

/** Archive the session file in place (renamed to `<id>.jsonl.archived-<ts>`; the search indexer indexes archived names). */
export function archiveSessionFile(path: string): void {
	const archived = `${path}.archived-${Date.now()}`;
	renameSync(path, archived);
}
