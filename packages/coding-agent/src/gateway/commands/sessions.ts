/**
 * Gateway `/sessions` command: browse/discover recent past sessions (the
 * discovery + browse mode of cross-session recall), backed by the same
 * persistent FTS5 index as `/search`. Gateway-local by ADR-0001. Project
 * isolation mirrors /search: anchored runs list only that project's sessions;
 * `--all` crosses explicitly and labels by project.
 */
import { listRecentSessions } from "../session-search.js";
import type { GatewayCommand, GatewayCommandContext } from "../types.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export interface ParseBrowseArgs {
	all: boolean;
	limit: number;
}
export type ParseBrowseResult = ParseBrowseArgs | { error: string };

export function parseBrowseArgs(args: string[]): ParseBrowseResult {
	let all = false;
	let limit = DEFAULT_LIMIT;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === undefined) continue;
		if (token === "--all") {
			all = true;
			continue;
		}
		if (token === "--limit" || token.startsWith("--limit=")) {
			const raw = token === "--limit" ? args[++i] : token.slice("--limit=".length);
			const n = Number.parseInt(raw ?? "", 10);
			if (Number.isFinite(n) && n > 0) limit = Math.min(n, MAX_LIMIT);
			continue;
		}
		if (token === "--help" || token === "-h") return { error: "usage: /sessions [--all] [--limit N]" };
		rest.push(token);
	}
	if (rest.length > 0) return { error: `unknown argument '${rest[0]}' — usage: /sessions [--all] [--limit N]` };
	return { all, limit };
}

export function renderSessionsReply(args: string[], ctx: GatewayCommandContext): string {
	const parsed = parseBrowseArgs(args);
	if ("error" in parsed) return parsed.error;
	if (!ctx.sessionsDir || !ctx.searchIndexPath) {
		return "sessions unavailable: no sessions directory / search index configured for this gateway run.";
	}
	const entries = listRecentSessions({
		sessionsDir: ctx.sessionsDir,
		indexPath: ctx.searchIndexPath,
		projectRoot: ctx.projectRoot,
		projectHome: ctx.projectHome,
		scope: parsed.all ? "all" : "project",
		limit: parsed.limit,
	});
	if (entries.length === 0) {
		return "no past sessions to browse yet. Start a conversation first.";
	}
	const lines = [`${entries.length} recent session(s):`];
	for (const e of entries) {
		const label = e.sessionName ? `${e.projectLabel}: ${e.sessionName}` : e.projectLabel;
		const when = new Date(e.modified).toISOString().slice(0, 10);
		const preview = e.firstMessage.slice(0, 60) || "(no message)";
		lines.push(`[${label}] ${when} ${e.shortId} — ${preview.length > 60 ? `${preview}…` : preview}`);
	}
	return lines.join("\n");
}

export const sessionsCommand: GatewayCommand = {
	name: "sessions",
	summary: "Browse recent past sessions",
	handler: renderSessionsReply,
};
