/**
 * Cross-session recall: a synchronous FTS5 full-text search over the agent's
 * past session archive (append-only JSONL files under the profile's sessions
 * dir). Built on the node:sqlite stdlib (FTS5 trigram tokenizer — no new
 * dependency), it answers "what did we decide about X last month?" that the
 * durable-fact memory tool cannot.
 *
 * Project isolation: a session belongs to a project iff its header cwd is
 * under that project's root (<projectHome>/projects/<name>). By default an
 * anchored search is scoped to one project; `scope: "all"` reaches across
 * projects ONLY explicitly, and every hit carries its project label so
 * projects never silently mix in one corpus.
 */

import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One indexable message from a session file. */
export interface SearchDoc {
	/** Row order inside the session (for stable display ordering). */
	seq: number;
	role: "user" | "assistant";
	/** Message wall-clock (ms epoch; 0 when absent/unparseable). */
	timestamp: number;
	/** Message text, capped for the index. */
	text: string;
}

/** A parsed session: header identity + its indexed messages. */
export interface ParsedSession {
	filePath: string;
	id: string;
	cwd: string;
	name?: string;
	docs: SearchDoc[];
}

export interface SearchHit {
	/** Full session id (uuid7). */
	sessionId: string;
	/** Header cwd of the session. */
	cwd: string;
	/** Project derived from cwd (name, or "workspace" when not under a project). */
	projectLabel: string;
	/** Short display id (first 7 chars). */
	shortId: string;
	timestamp: number;
	role: "user" | "assistant";
	/** Matched message text (for the snippet), kept short. */
	snippet: string;
	/** bm25 relevance (lower is better; negative values possible). */
	rank: number;
	sessionName?: string;
}

export interface SearchResult {
	hits: SearchHit[];
	/** Session files scanned. */
	sessionsScanned: number;
	/** Sessions that produced at least one match. */
	sessionsMatched: number;
	/** True when the query is below the index's minimum token length. */
	queryTooShort: boolean;
}

export interface SearchOptions {
	sessionsDir: string;
	query: string;
	/** Anchored project root; when set, default scope restricts to it. */
	projectRoot?: string;
	/** Profile home used to derive project labels from cwd. */
	projectHome?: string;
	/** "project" (default) scopes to projectRoot when present. "all" crosses projects. */
	scope?: "project" | "all";
	/** Max hits to return. */
	limit?: number;
	/** Inject optional FS access (tests). */
	readdir?: (dir: string) => string[];
}

/** Caps that bound a single search (archive size / per-session / per-message). */
export const SEARCH_MAX_SESSION_FILES = 2000;
export const SEARCH_MAX_SESSION_TEXT_CHARS = 64 * 1024;
export const SEARCH_MAX_MESSAGE_CHARS = 4000;
export const SEARCH_MIN_QUERY_LENGTH = 3;

/** FTS5 phrase-escape: only `"` and `\` are special inside double-quoted text. */
export function ftsPhrase(query: string): string {
	const q = query.trim().replace(/\s+/g, " ");
	return `"${q.replace(/\\/g, "\\\\").replace(/"/g, '""')}"`;
}

/** True when `path` is `root` or strictly inside it. */
export function isWithin(root: string, path: string): boolean {
	const r = resolve(root);
	const p = resolve(path);
	return p === r || p.startsWith(r + sep);
}

/**
 * Derive a short project label from a session cwd: the project name when the
 * cwd sits under <projectHome>/projects/<name>, else "workspace".
 */
export function projectLabelForCwd(cwd: string, projectHome?: string): string {
	if (!cwd || !projectHome) return "workspace";
	const projectsRoot = join(projectHome, "projects");
	const rel = relative(projectsRoot, cwd);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "workspace";
	return rel.split(sep)[0] ?? "workspace";
}

function looksLikeJsonObject(line: string): boolean {
	const t = line.trim();
	return t.startsWith("{") && t.endsWith("}");
}

function textOf(message: { content?: string | Array<{ type?: string; text?: string }> }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join(" ");
}

/** Parse one JSONL session file into header identity + indexed message docs. */
export function parseSessionFile(filePath: string, readFile = readFileSyncText): ParsedSession | null {
	const raw = readFile(filePath);
	if (!raw) return null;
	let id = "";
	let cwd = "";
	let name: string | undefined;
	let sawHeader = false;
	const docs: SearchDoc[] = [];
	let seq = 0;
	let sessionText = 0;

	for (const line of raw.split(/\r?\n/)) {
		if (!looksLikeJsonObject(line)) continue;
		let entry: {
			type?: string;
			id?: string;
			cwd?: string;
			name?: string;
			timestamp?: string;
			message?: { role?: string; content?: unknown };
		};
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue; // malformed line — skip, never fail the whole archive
		}
		if (entry.type === "session") {
			sawHeader = true;
			id = entry.id ?? "";
			cwd = entry.cwd ?? "";
			continue;
		}
		if (!sawHeader) continue;
		if (entry.type === "session_info") {
			if (typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim();
			continue;
		}
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(entry.message as { content?: string | Array<{ type?: string; text?: string }> });
		if (!text) continue;
		if (sessionText >= SEARCH_MAX_SESSION_TEXT_CHARS) continue;
		const tsRaw = typeof entry.timestamp === "string" ? new Date(entry.timestamp).getTime() : NaN;
		docs.push({
			seq: seq++,
			role,
			timestamp: Number.isNaN(tsRaw) ? 0 : tsRaw,
			text: text.slice(0, SEARCH_MAX_MESSAGE_CHARS),
		});
		sessionText += text.length;
	}

	if (!sawHeader) return null;
	return { filePath, id, cwd, name, docs };
}

function readFileSyncText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function collectSessionFiles(sessionsDir: string, readdir?: (dir: string) => string[]): string[] {
	const read = readdir ?? defaultReaddir;
	let names: string[];
	try {
		names = read(sessionsDir);
	} catch {
		return [];
	}
	return names
		.filter((n) => n.endsWith(".jsonl"))
		.slice(0, SEARCH_MAX_SESSION_FILES)
		.map((n) => join(sessionsDir, n));
}

function defaultReaddir(dir: string): string[] {
	try {
		return readdirSync(dir, { encoding: "utf8" });
	} catch {
		return [];
	}
}

function openFtsIndex(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(
		`CREATE VIRTUAL TABLE session_search USING fts5(
			session_id, cwd, ts, role, session_name, seq, text,
			tokenize = 'trigram'
		);`,
	);
	return db;
}

/** Build an in-memory FTS5 index over the parsed sessions. */
export function buildFtsIndex(db: DatabaseSync, sessions: ParsedSession[]): void {
	const insert = db.prepare(
		"INSERT INTO session_search(session_id, cwd, ts, role, session_name, seq, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	for (const session of sessions) {
		for (const doc of session.docs) {
			insert.run(session.id, session.cwd, doc.timestamp, doc.role, session.name ?? null, doc.seq, doc.text);
		}
	}
}

export function runFtsQuery(
	db: DatabaseSync,
	phrase: string,
): Array<{
	session_id: string;
	cwd: string;
	ts: number;
	role: string;
	session_name: string | null;
	text: string;
	score: number;
}> {
	const stmt = db.prepare(
		`SELECT session_id, cwd, ts, role, session_name, text,
			bm25(session_search) AS score
		FROM session_search
		WHERE session_search MATCH ?
		ORDER BY score`,
	);
	return stmt.all(phrase) as Array<{
		session_id: string;
		cwd: string;
		ts: number;
		role: string;
		session_name: string | null;
		text: string;
		score: number;
	}>;
}

function projectScopeFilter(options: SearchOptions): (session: ParsedSession) => boolean {
	if (options.scope === "all") return () => true;
	if (options.projectRoot) {
		const root = options.projectRoot;
		return (session) => isWithin(root, session.cwd);
	}
	return () => true; // unanchored: the whole profile corpus is one workspace
}

/** Search past sessions with an FTS5 index; returns ranked hits plus stats. */
export function searchSessions(options: SearchOptions): SearchResult {
	const query = options.query.trim();
	if (query.length < SEARCH_MIN_QUERY_LENGTH) {
		return { hits: [], sessionsScanned: 0, sessionsMatched: 0, queryTooShort: true };
	}
	const files = collectSessionFiles(options.sessionsDir, options.readdir);
	const sessions: ParsedSession[] = [];
	const filter = projectScopeFilter(options);
	for (const file of files) {
		const session = parseSessionFile(file);
		if (session && filter(session)) sessions.push(session);
	}
	const db = openFtsIndex();
	try {
		buildFtsIndex(db, sessions);
		const phrase = ftsPhrase(query);
		const rows = runFtsQuery(db, phrase);
		const projectHome = options.projectHome;
		const limit = Math.max(1, Math.min(options.limit ?? 10, 25));
		const seenSessions = new Set<string>();
		const hits: SearchHit[] = [];
		for (const row of rows) {
			if (hits.length >= limit) break;
			const sessionId = row.session_id;
			const firstInSession = !seenSessions.has(sessionId);
			if (firstInSession) seenSessions.add(sessionId);
			hits.push({
				sessionId,
				cwd: row.cwd,
				projectLabel: projectLabelForCwd(row.cwd, projectHome),
				shortId: sessionId.slice(0, 7),
				timestamp: row.ts,
				role: row.role === "assistant" ? "assistant" : "user",
				snippet: row.text.slice(0, 280),
				rank: row.score as number,
				...(firstInSession && row.session_name ? { sessionName: row.session_name } : {}),
			});
		}
		return { hits, sessionsScanned: sessions.length, sessionsMatched: seenSessions.size, queryTooShort: false };
	} finally {
		db.close();
	}
}
