/**
 * Recall extension: an agent-facing `recall` tool that surfaces past-session
 * content (cross-session recall) so the model can summarize it and decide to
 * persist durable facts via the memory tool — "LLM-summarized recall, memory
 * surfaced from past sessions rather than only hand-recorded."
 *
 * It reuses the persistent FTS5 session index built for the gateway `/search`
 * (session-search.ts); the two surfaces read the same correlated index
 * (<AXIOM_HOME>/search/session-recall.sqlite). Unlike the gateway command, a
 * tool reaches the MODEL (ADR-0001 only constrains gateway commands), so this
 * is where summarization belongs.
 *
 * Project isolation mirrors /search: an anchored run (AXIOM_PROJECT_ROOT) is
 * scoped to that project by default; `all: true` crosses projects and every
 * hit carries its project label. Paths are injectable for tests.
 */

import { join } from "node:path";
import { type Static, Type } from "typebox";
import { getAgentDir, getSessionsDir } from "../../config.js";
import type { ExtensionAPI } from "../../core/extensions/types.js";
import {
	type BrowseEntry,
	type BrowseOptions,
	listRecentSessions,
	type SearchOptions,
	type SearchResult,
	searchSessions,
} from "../../gateway/session-search.js";
import { axiomHome } from "../profile/registry.js";

const RecallParamsSchema = Type.Object({
	/** "query" (search) or "recent" (browse the newest sessions). */
	action: Type.Optional(Type.Union([Type.Literal("query"), Type.Literal("recent")])),
	/** Free-text query — required for action=query. */
	query: Type.Optional(Type.String()),
	/** Cross project boundaries (labeled by project) when true. */
	all: Type.Optional(Type.Boolean()),
	/** Max results to return (default 8, capped 25). */
	limit: Type.Optional(Type.Number()),
});

type RecallParams = Static<typeof RecallParamsSchema>;

export interface RecallDeps {
	/** Sessions archive directory (defaults to the active agent's sessions dir). */
	sessionsDir?: string;
	/** Persistent FTS index file (defaults to <AXIOM_HOME>/search/session-recall.sqlite). */
	indexPath?: string;
	/** Anchored project root (defaults to AXIOM_PROJECT_ROOT). */
	projectRoot?: string;
	/** Profile home used for project labels (defaults to the axiom home). */
	projectHome?: string;
	/** Injectable so tests never touch disk beyond a temp sqlite. */
	search?: (o: SearchOptions) => SearchResult;
	recent?: (o: BrowseOptions) => BrowseEntry[];
}

/** Resolve the production recall paths from the environment (mirrors the gateway). */
export function defaultRecallPaths(): {
	sessionsDir: string;
	indexPath: string;
	projectRoot?: string;
	projectHome: string;
} {
	const agentDir = getAgentDir();
	return {
		sessionsDir: getSessionsDir(agentDir),
		indexPath: join(axiomHome(), "search", "session-recall.sqlite"),
		projectRoot: process.env.AXIOM_PROJECT_ROOT,
		projectHome: axiomHome(),
	};
}

/** One-line hit renderer for the model (longer snippets than the gateway's). */
export function formatRecallResult(result: SearchResult): string {
	if (result.queryTooShort) {
		return "(recall query is too short — use action=recent to browse the newest sessions)";
	}
	if (result.hits.length === 0) {
		return `(no past-session matches across ${result.sessionsIndexed} indexed session(s); try action=recent to browse, or a different query)`;
	}
	const lines = [`recall — ${result.hits.length} hit(s) across ${result.sessionsMatched} session(s):`];
	for (const h of result.hits) {
		const label = h.sessionName ? `${h.projectLabel}: ${h.sessionName}` : h.projectLabel;
		const speaker = h.role === "user" ? "user" : "axiom";
		lines.push(`[${label}] ${h.shortId} (${speaker}): ${h.snippet}`);
	}
	return lines.join("\n");
}

export function formatRecallRecent(entries: BrowseEntry[]): string {
	if (entries.length === 0) return "(no recent past sessions yet)";
	const lines = [`recent sessions (${entries.length}):`];
	for (const e of entries) {
		const label = e.sessionName ? `${e.projectLabel}: ${e.sessionName}` : e.projectLabel;
		const when = new Date(e.modified).toISOString().slice(0, 10);
		lines.push(`[${label}] ${when} ${e.shortId}: ${e.firstMessage || "(no message)"}`);
	}
	return lines.join("\n");
}

export function createRecallExtension(deps?: Partial<RecallDeps>): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		const paths = defaultRecallPaths();
		const sessionsDir = deps?.sessionsDir ?? paths.sessionsDir;
		const indexPath = deps?.indexPath ?? paths.indexPath;
		const projectRoot = deps?.projectRoot ?? paths.projectRoot;
		const projectHome = deps?.projectHome ?? paths.projectHome;
		const doSearch = deps?.search ?? (searchSessions as (o: SearchOptions) => SearchResult);
		const doRecent = deps?.recent ?? (listRecentSessions as (o: BrowseOptions) => BrowseEntry[]);

		pi.registerTool({
			name: "recall",
			label: "Recall past sessions",
			description:
				"Recall what happened in earlier conversations. Use a free-text query to search past sessions " +
				'(e.g. "what did we decide about X"), or action=recent to browse the newest ones. Returns ' +
				"snippets you can summarize. Anchored runs search only the current project unless all=true. " +
				"Pair with the memory tool to persist durable facts you learn from past sessions.",
			parameters: RecallParamsSchema,
			execute: async (_toolCallId, params: RecallParams) => {
				const action = params.action === "recent" ? "recent" : "query";
				const all = params.all === true;
				const scope = all ? "all" : "project";
				const limit = params.limit ? Math.max(1, Math.min(Math.floor(params.limit), 25)) : 8;
				if (action === "recent") {
					const entries = doRecent({ sessionsDir, indexPath, projectRoot, projectHome, scope, limit });
					return { content: [{ type: "text", text: formatRecallRecent(entries) }], details: null };
				}
				const query = (params.query ?? "").trim();
				if (!query) {
					return {
						content: [
							{ type: "text", text: "(recall action=query requires a query; use action=recent to browse)" },
						],
						details: null,
					};
				}
				const result = doSearch({ sessionsDir, indexPath, query, projectRoot, projectHome, scope, limit });
				return { content: [{ type: "text", text: formatRecallResult(result) }], details: null };
			},
		});
	};
}

export default function axiomRecallExtension(pi: ExtensionAPI): void {
	createRecallExtension()(pi);
}
