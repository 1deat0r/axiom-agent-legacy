/**
 * The peers facade: register a run, heartbeat, set intent, send messages
 * (directed or group), and read the inbox. All state is plain files under a
 * scope dir; every dependency is injectable so tests never touch real pids.
 */

import { randomUUID } from "node:crypto";
import {
	appendBoardEntry,
	type BoardDeps,
	type BoardFileStat,
	boardStat,
	readBoardSince,
	readCursor,
	writeCursor,
} from "./board.js";
import {
	DEFAULT_STALE_MS,
	heartbeatPresence,
	isPeerAlive,
	listPresence,
	unregisterPresence,
	updatePresence,
	writePresence,
} from "./presence.js";
import type { BoardEntry, InboxResult, PeerIdentity, PeerSummary, PeersListResult, PresenceRecord } from "./types.js";

export const MAX_MESSAGE_LENGTH = 4000;
const TARGET_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export interface PeersDeps {
	now?: () => number;
	staleMs?: number;
	pid?: number;
	pidAlive?: (pid: number) => boolean;
	uuid?: () => string;
}

export interface RegisterOptions {
	model?: string;
	intent?: string;
}

export function defaultPidAlive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Publish this run's presence and return its run ID. */
export function registerRun(
	scope: string,
	identity: PeerIdentity,
	options: RegisterOptions = {},
	deps: PeersDeps = {},
): string {
	const now = deps.now ?? Date.now;
	const runId = deps.uuid ? deps.uuid() : randomUUID();
	const record: PresenceRecord = {
		instanceId: identity.instanceId,
		runId,
		pid: deps.pid ?? process.pid,
		model: options.model ?? "",
		intent: options.intent ?? "",
		startedAt: new Date(now()).toISOString(),
		heartbeatAt: new Date(now()).toISOString(),
	};
	writePresence(scope, record);
	return runId;
}

/** Update this run's intent so peers can see what it is doing. */
export function setIntent(scope: string, runId: string, intent: string, deps: PeersDeps = {}): boolean {
	const now = deps.now ?? Date.now;
	return updatePresence(
		scope,
		runId,
		{ intent: intent.slice(0, 500), heartbeatAt: new Date(now()).toISOString() },
		{ now: deps.now },
	);
}

/** Bump this run's heartbeat; false when the presence record is gone. */
export function heartbeatRun(scope: string, runId: string, deps: PeersDeps = {}): boolean {
	return heartbeatPresence(scope, runId, { now: deps.now });
}

/** Append a directed (to=<instanceId>) or group (to="*") message. */
export function sendPeerMessage(
	scope: string,
	identity: PeerIdentity,
	runId: string,
	to: string,
	text: string,
	deps: PeersDeps = {},
): void {
	const trimmed = text.trim();
	if (trimmed === "") throw new Error("peer message text is empty");
	if (trimmed.length > MAX_MESSAGE_LENGTH) {
		throw new Error(`peer message exceeds ${MAX_MESSAGE_LENGTH} characters`);
	}
	if (to !== "*" && !TARGET_PATTERN.test(to)) {
		throw new Error(`invalid peer target: ${to}`);
	}
	const now = deps.now ?? Date.now;
	const entry: BoardEntry = {
		ts: new Date(now()).toISOString(),
		from: identity.instanceId,
		fromRun: runId,
		to,
		kind: to === "*" ? "group" : "msg",
		text: trimmed,
	};
	appendBoardEntry(scope, entry);
}

function inboxMessages(scope: string, identity: PeerIdentity, markRead: boolean, deps: BoardDeps = {}): InboxResult {
	const cursor = readCursor(scope, identity.instanceId, deps);
	const { entries, nextCursor } = readBoardSince(scope, cursor, deps);
	const mine = entries.filter((e) => e.to === "*" || e.to === identity.instanceId);
	if (markRead) writeCursor(scope, identity.instanceId, nextCursor, deps);
	return { messages: mine };
}

/** Read unread messages (group + directed at me) and mark them read. */
export function inbox(scope: string, identity: PeerIdentity): InboxResult {
	return inboxMessages(scope, identity, true);
}

/**
 * Per-caller peek state: the last board stat this caller observed. Kept by
 * the caller across turns so an unchanged board short-circuits the parse.
 */
export interface PeekCache {
	lastBoardStat?: BoardFileStat;
}

/** True when the board stat has not moved since the caller last peeked. */
function boardUnchanged(cached: BoardFileStat | undefined, current: BoardFileStat): boolean {
	return cached !== undefined && cached.size === current.size && cached.mtimeMs === current.mtimeMs;
}

/**
 * Read unread messages without marking them read (CLI peek).
 *
 * With a caller-held `cache`, an unchanged board (same size + mtime since
 * the last peek) returns no messages without reading or parsing the board
 * or the cursor file. The board is append-only, so an unchanged stat means
 * no new line can have landed; the full unread set is still available via
 * `inbox`/`peers_inbox`. Callers that want every unread message on every
 * call (the CLI) simply pass no cache — a cold cache always reads.
 */
export function peekInbox(
	scope: string,
	identity: PeerIdentity,
	cache: PeekCache = {},
	deps: BoardDeps = {},
): InboxResult {
	const current = boardStat(scope, deps);
	if (boardUnchanged(cache.lastBoardStat, current)) {
		return { messages: [] };
	}
	// Snapshot, never alias: the injected stat function (and callers that
	// mutate the object it returned) must not rewrite the cached observation.
	cache.lastBoardStat = { ...current };
	return inboxMessages(scope, identity, false, deps);
}

/** List peers: own runs, then others split into active and stale. */
export function listPeers(scope: string, identity: PeerIdentity, deps: PeersDeps = {}): PeersListResult {
	const now = deps.now ?? Date.now;
	const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
	const pidAlive = deps.pidAlive ?? defaultPidAlive;
	const records = listPresence(scope);
	const summarize = (r: PresenceRecord): PeerSummary => ({
		instanceId: r.instanceId,
		shortId: r.instanceId.slice(0, 8),
		runId: r.runId,
		pid: r.pid,
		model: r.model,
		intent: r.intent,
		startedAt: r.startedAt,
		lastSeen: r.heartbeatAt,
		status: isPeerAlive(r, now(), staleMs, pidAlive) ? "active" : "stale",
	});
	const summaries = records.map(summarize);
	return {
		self: summaries.filter((s) => s.instanceId === identity.instanceId),
		active: summaries.filter((s) => s.instanceId !== identity.instanceId && s.status === "active"),
		stale: summaries.filter((s) => s.instanceId !== identity.instanceId && s.status === "stale"),
	};
}

/** Remove this run's presence (session shutdown). */
export function unregisterRun(scope: string, runId: string): void {
	unregisterPresence(scope, runId);
}
