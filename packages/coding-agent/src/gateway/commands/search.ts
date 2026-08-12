/**
 * Gateway `/search` command: cross-session recall over a persistent FTS5 index
 * of the past session archive (session-search.ts). Gateway-local by ADR-0001 —
 * it never reaches the model. Project isolation: an anchored run
 * (ctx.projectRoot set) searches only that project by default; `--all`
 * explicitly crosses projects and every hit carries its project label so
 * projects never mix silently. Unanchored runs treat the profile as one
 * workspace. `--offset N` scrolls further into the ranked results.
 */
import { searchSessions } from "../session-search.js";
import type { GatewayCommand, GatewayCommandContext } from "../types.js";

export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 25;
export const SEARCH_MAX_OFFSET = 200;

export interface ParsedSearchArgs {
	query: string;
	all: boolean;
	limit: number;
	offset: number;
}
export type ParsedSearchResult = ParsedSearchArgs | { error: string };

/** Parse "/search [--all] [--limit N] [--offset N] <query>" (flags may appear anywhere). */
export function parseSearchArgs(args: string[]): ParsedSearchResult {
	let all = false;
	let limit = SEARCH_DEFAULT_LIMIT;
	let offset = 0;
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
			if (Number.isFinite(n) && n > 0) limit = Math.min(n, SEARCH_MAX_LIMIT);
			continue;
		}
		if (token === "--offset" || token.startsWith("--offset=")) {
			const raw = token === "--offset" ? args[++i] : token.slice("--offset=".length);
			const n = Number.parseInt(raw ?? "", 10);
			if (Number.isFinite(n) && n >= 0) offset = Math.min(n, SEARCH_MAX_OFFSET);
			continue;
		}
		rest.push(token);
	}
	const query = rest.join(" ").trim();
	if (!query) return { error: "usage: /search [--all] [--limit N] [--offset N] <query>" };
	return { query, all, limit, offset };
}

function formatDate(timestamp: number): string {
	if (!timestamp) return "????-??-??";
	return new Date(timestamp).toISOString().slice(0, 10);
}

/** Render the search reply (telegram transport chunks >4096 itself). */
export function renderSearchReply(args: string[], ctx: GatewayCommandContext): string {
	const parsed = parseSearchArgs(args);
	if ("error" in parsed) return parsed.error;
	if (!ctx.sessionsDir || !ctx.searchIndexPath) {
		return "search unavailable: no sessions directory / search index configured for this gateway run.";
	}
	const result = searchSessions({
		sessionsDir: ctx.sessionsDir,
		indexPath: ctx.searchIndexPath,
		query: parsed.query,
		projectRoot: ctx.projectRoot,
		projectHome: ctx.projectHome,
		scope: parsed.all ? "all" : "project",
		limit: parsed.limit,
		offset: parsed.offset,
	});
	if (result.queryTooShort) return `search query too short (min 3 characters): "${parsed.query}"`;
	if (result.hits.length === 0) {
		const reason = result.outOfRange
			? `no more results past offset ${parsed.offset}`
			: `no past sessions matched "${parsed.query}"`;
		return `${reason} across ${result.sessionsIndexed} indexed session(s).`;
	}
	const lines = [`${result.hits.length} match(es) across ${result.sessionsMatched} past session(s):`];
	for (const hit of result.hits) {
		const label = hit.sessionName ? `${hit.projectLabel}: ${hit.sessionName}` : hit.projectLabel;
		const speaker = hit.role === "user" ? "you" : "axiom";
		const snippet = hit.snippet.length > 60 ? `${hit.snippet.slice(0, 60)}…` : hit.snippet;
		lines.push(`[${label}] ${formatDate(hit.timestamp)} ${hit.shortId} ${speaker} — ${snippet}`);
	}
	if (parsed.offset > 0 || result.sessionsMatched >= parsed.limit) {
		lines.push(`(offset ${parsed.offset} · use --offset ${parsed.offset + parsed.limit} for more)`);
	}
	return lines.join("\n");
}

export const searchCommand: GatewayCommand = {
	name: "search",
	summary: "Search past sessions",
	handler: renderSearchReply,
};
