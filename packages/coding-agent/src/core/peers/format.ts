/** Human/model-facing renderers for peer state. */

import type { BoardEntry, PeersListResult } from "./types.js";

function line(summary: { shortId: string; runId: string; model: string; intent: string; lastSeen: string }): string {
	const parts = [`${summary.shortId}`, `run ${summary.runId.slice(0, 8)}`];
	if (summary.model) parts.push(`model ${summary.model}`);
	if (summary.intent) parts.push(`"${summary.intent}"`);
	parts.push(`last seen ${summary.lastSeen}`);
	return `  ${parts.join(" — ")}`;
}

export function formatPeersList(result: PeersListResult, selfShortId?: string): string {
	const you = selfShortId ? ` (you: ${selfShortId})` : "";
	const lines: string[] = [];
	if (result.self.length > 0) {
		lines.push("peer agents in this project (your runs):");
		for (const s of result.self) lines.push(line(s));
		lines.push("");
	}
	if (result.active.length === 0 && result.stale.length === 0 && result.self.length === 0) {
		return `peer agents in this project${you}: (none — you are the only instance here)`;
	}
	lines[0] = `peer agents in this project${you}:`;
	if (result.active.length > 0) {
		lines.push(`active (${result.active.length}):`);
		for (const s of result.active) lines.push(line(s));
	}
	if (result.stale.length > 0) {
		lines.push(`stale (${result.stale.length}) (crashed or idle):`);
		for (const s of result.stale) lines.push(line(s));
	}
	return lines.join("\n");
}

export function formatInbox(messages: BoardEntry[]): string {
	if (messages.length === 0) return "(no new peer messages)";
	const lines = [`peer inbox — ${messages.length} unread:`];
	for (const m of messages) {
		const kind = m.kind === "group" ? "group" : "msg";
		lines.push(`[${kind}] from ${m.from.slice(0, 8)} (${m.ts}): ${m.text}`);
	}
	return lines.join("\n");
}
