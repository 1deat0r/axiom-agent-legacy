/**
 * Peer coordination types (ADR-0038).
 *
 * A peer is another axiom-agent instance anchored to the same project root.
 * Instances are addressed by a stable instance ID (one per axiom home); runs
 * are per-process and keyed by run ID.
 */

/** Stable identity for one axiom home. */
export interface PeerIdentity {
	instanceId: string;
	/** First 8 characters, for humans. */
	shortId: string;
}

/** What one run publishes about itself. */
export interface PresenceRecord {
	instanceId: string;
	runId: string;
	pid: number;
	model: string;
	intent: string;
	startedAt: string;
	heartbeatAt: string;
}

/** Board entry kind. */
export type BoardKind = "msg" | "group";

/** One line on the append-only board. `to` is "*" for group chat, else a target instance ID. */
export interface BoardEntry {
	ts: string;
	from: string;
	fromRun: string;
	to: string;
	kind: BoardKind;
	text: string;
}

/** A peer as rendered to the model or the CLI. */
export interface PeerSummary {
	instanceId: string;
	shortId: string;
	runId: string;
	pid: number;
	model: string;
	intent: string;
	startedAt: string;
	lastSeen: string;
	status: "active" | "stale";
}

/** Result of listing peers: own runs, then others split by liveness. */
export interface PeersListResult {
	self: PeerSummary[];
	active: PeerSummary[];
	stale: PeerSummary[];
}

/** Result of reading the inbox. */
export interface InboxResult {
	messages: BoardEntry[];
}
