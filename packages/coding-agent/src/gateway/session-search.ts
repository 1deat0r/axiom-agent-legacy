/**
 * Cross-session recall: a full-text (FTS5) search over the agent's past
 * session archive (append-only JSONL files under the profile's sessions dir),
 * backed by a PERSISTENT SQLite index that is reconciled incrementally by file
 * size+mtime — so repeated searches don't rescan the whole archive. Built on
 * the node:sqlite stdlib (FTS5 trigram tokenizer; no new dependency).
 *
 * The index ("the SQLite session DB index"): an `entries` table of indexed
 * messages plus a `sessions` table of reconciliation metadata (size, mtime,
 * cwd, name, first message), with an FTS5 virtual table kept in sync by
 * triggers. It answers "what did we decide about X last month?" that the
 * durable-fact memory tool cannot.
 *
 * Project isolation: a session belongs to a project iff its header cwd is
 * under that project's root (<projectHome>/projects/<name>). By default an
 * anchored search is scoped to one project; `scope: "all"` reaches across
 * projects ONLY explicitly, and every hit carries its project label so
 * projects never silently mix in one corpus.
 */

import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
	/** First user message text (for browse preview). */
	firstMessage: string;
	docs: SearchDoc[];
}

export interface SearchHit {
	sessionId: string;
	cwd: string;
	projectLabel: string;
	shortId: string;
	timestamp: number;
	role: "user" | "assistant";
	snippet: string;
	rank: number;
	sessionName?: string;
}

export interface SearchResult {
	hits: SearchHit[];
	/** Sessions present in the persistent index after reconciliation. */
	sessionsIndexed: number;
	/** Sessions among the returned hits. */
	sessionsMatched: number;
	/** True when the query is below the index's minimum token length. */
	queryTooShort: boolean;
	/** True when an offset consumed the whole result set. */
	outOfRange: boolean;
}

/** A browsable session (discovery mode), newest-first. */
export interface BrowseEntry {
	sessionId: string;
	shortId: string;
	cwd: string;
	projectLabel: string;
	firstMessage: string;
	modified: number;
	sessionName?: string;
}

export interface SearchOptions {
	sessionsDir: string;
	/** Persistent SQLite index file (created on first use). */
	indexPath: string;
	query: string;
	projectRoot?: string;
	projectHome?: string;
	scope?: "project" | "all";
	limit?: number;
	/** Skip this many ranked message rows (scroll/paging). */
	offset?: number;
	readdir?: (dir: string) => string[];
}

export interface BrowseOptions {
	sessionsDir: string;
	indexPath: string;
	projectRoot?: string;
	projectHome?: string;
	scope?: "project" | "all";
	limit?: number;
	readdir?: (dir: string) => string[];
}

/** Caps that bound a single reconcile/search. */
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

/** Short project label for a cwd: name when under <projectHome>/projects/<name>, else "workspace". */
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

/** Parse one JSONL session file into header identity + indexable message docs. */
export function parseSessionFile(filePath: string, readFile = readFileSyncText): ParsedSession | null {
	const raw = readFile(filePath);
	if (!raw) return null;
	let id = "";
	let cwd = "";
	let name: string | undefined;
	let sawHeader = false;
	let firstMessage = "";
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
		if (!firstMessage && role === "user") firstMessage = text.slice(0, 200);
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
	return { filePath, id, cwd, name, firstMessage, docs };
}

function readFileSyncText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function defaultReaddir(dir: string): string[] {
	try {
		return readdirSync(dir, { encoding: "utf8" });
	} catch {
		return [];
	}
}

/** Archived session names: `<id>.jsonl.archived-<epochMs>` (kept searchable). */
const ARCHIVED_NAME_RE = /\.jsonl\.archived-(\d+)$/;

function isArchivedName(name: string): boolean {
	return ARCHIVED_NAME_RE.test(name);
}

/** Current .jsonl files in the sessions dir as {sessionId, size, mtime}. */

function collectSessionFiles(
	sessionsDir: string,
	readdir?: (dir: string) => string[],
): Array<{ file: string; size: number; mtime: number }> {
	const read = readdir ?? defaultReaddir;
	let names: string[];
	try {
		names = read(sessionsDir);
	} catch {
		return [];
	}
	const out: Array<{ file: string; size: number; mtime: number }> = [];
	for (const n of names) {
		if (!n.endsWith(".jsonl") && !isArchivedName(n)) continue;
		const file = join(sessionsDir, n);
		try {
			const st = statSync(file);
			out.push({ file, size: st.size, mtime: Math.floor(st.mtimeMs) });
		} catch {
			// unreadable/stat-failed file: skip
		}
		if (out.length >= SEARCH_MAX_SESSION_FILES) break;
	}
	return out;
}

/** Open the persistent index DB and ensure schema + FTS triggers exist. */
export function openIndexDb(indexPath: string, mkdirp = true): DatabaseSync {
	if (mkdirp) {
		mkdirSync(dirname(indexPath), { recursive: true });
	}
	const db = new DatabaseSync(indexPath);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec(
		`CREATE TABLE IF NOT EXISTS sessions (
			session_id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL,
			size INTEGER NOT NULL,
			mtime_ms INTEGER NOT NULL,
			cwd TEXT NOT NULL,
			session_name TEXT,
			first_message TEXT NOT NULL,
			modified INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS entries (
			rowid INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			role TEXT NOT NULL,
			ts INTEGER NOT NULL,
			seq INTEGER NOT NULL,
			text TEXT NOT NULL
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS session_search_fts USING fts5(
			payload,
			content='entries', content_rowid='rowid',
			tokenize='trigram'
		);
		CREATE TRIGGER IF NOT EXISTS session_search_fts_ai AFTER INSERT ON entries BEGIN
			INSERT INTO session_search_fts(rowid, payload) VALUES (new.rowid, new.text);
		END;
		CREATE TRIGGER IF NOT EXISTS session_search_fts_ad AFTER DELETE ON entries BEGIN
			INSERT INTO session_search_fts(session_search_fts, rowid, payload) VALUES('delete', old.rowid, old.text);
		END;
		CREATE TRIGGER IF NOT EXISTS session_search_fts_au AFTER UPDATE OF text ON entries BEGIN
			INSERT INTO session_search_fts(session_search_fts, rowid, payload) VALUES('delete', old.rowid, old.text);
			INSERT INTO session_search_fts(rowid, payload) VALUES (new.rowid, new.text);
		END;`,
	);
	return db;
}

/** Remove every entry + session row for one session id (FTS cleaned via triggers). */
function removeSession(db: DatabaseSync, sessionId: string): void {
	db.prepare("DELETE FROM entries WHERE session_id = ?").run(sessionId);
	db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
}

function insertSession(db: DatabaseSync, session: ParsedSession, filePath: string, size: number, mtime: number): void {
	db.prepare(
		"INSERT INTO sessions(session_id, file_path, size, mtime_ms, cwd, session_name, first_message, modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(session.id, filePath, size, mtime, session.cwd, session.name ?? null, session.firstMessage, mtime);
	const ins = db.prepare("INSERT INTO entries(session_id, role, ts, seq, text) VALUES (?, ?, ?, ?, ?)");
	for (const doc of session.docs) {
		ins.run(session.id, doc.role, doc.timestamp, doc.seq, doc.text);
	}
}

/**
 * Reconcile the persistent index with the sessions dir: files whose
 * (size, mtime) are unchanged are skipped; changed/new files are re-indexed;
 * deleted files are dropped. Returns the number of sessions now indexed.
 */
export function reconcileIndex(db: DatabaseSync, sessionsDir: string, readdir?: (dir: string) => string[]): number {
	const files = collectSessionFiles(sessionsDir, readdir);
	const currentPaths = new Set(files.map((f) => f.file));
	const byPath = new Map<string, { file: string; size: number; mtime: number }>();
	for (const f of files) byPath.set(f.file, f);

	const existingRows = db.prepare("SELECT session_id, file_path, size, mtime_ms FROM sessions").all() as Array<{
		session_id: string;
		file_path: string;
		size: number;
		mtime_ms: number;
	}>;
	const existingByPath = new Map(
		existingRows.map((r) => [r.file_path, { session_id: r.session_id, size: r.size, mtime: r.mtime_ms }]),
	);

	for (const f of files) {
		const e = existingByPath.get(f.file);
		if (e && e.size === f.size && e.mtime === f.mtime) continue; // unchanged
		if (e) removeSession(db, e.session_id);
		const session = parseSessionFile(f.file);
		if (session) {
			// An archived file shares its header id with the live file that
			// replaced it; index it under a derived id so both stay searchable.
			const name = basename(f.file);
			if (isArchivedName(name)) {
				const ts = name.match(ARCHIVED_NAME_RE)?.[1] ?? "";
				session.id = `${session.id}.archived-${ts}`;
			}
			insertSession(db, session, f.file, f.size, f.mtime);
		}
	}
	for (const [filePath, e] of existingByPath) {
		if (!currentPaths.has(filePath)) removeSession(db, e.session_id);
	}
	const row = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
	return row.n;
}

/** Project-scope SQL predicate over `s.cwd`; empty when scope is "all"/unanchored. */
function projectPredicate(params: SearchOptions["scope"], projectRoot?: string): { sql: string; args: string[] } {
	if (params !== "project" || !projectRoot) return { sql: "", args: [] };
	const root = resolve(projectRoot);
	return {
		sql: ` AND (s.cwd = ? OR (instr(s.cwd, ?) = 1 AND substr(s.cwd, length(?) + 1, 1) = '/'))`,
		args: [root, root, root],
	};
}

export function searchSessions(options: SearchOptions): SearchResult {
	const query = options.query.trim();
	if (query.length < SEARCH_MIN_QUERY_LENGTH) {
		return { hits: [], sessionsIndexed: 0, sessionsMatched: 0, queryTooShort: true, outOfRange: false };
	}
	const { sql: projSql, args: projArgs } = projectPredicate(options.scope, options.projectRoot);
	const offset = Math.max(0, options.offset ?? 0);
	const limit = Math.max(1, Math.min(options.limit ?? 10, 25));

	const db = openIndexDb(options.indexPath);
	try {
		const sessionsIndexed = reconcileIndex(db, options.sessionsDir, options.readdir);
		const phrase = ftsPhrase(query);
		const stmt = db.prepare(
			`SELECT e.session_id AS session_id, e.role AS role, e.ts AS ts, e.text AS text,
					s.cwd AS cwd, s.session_name AS session_name,
					bm25(session_search_fts) AS score
				FROM session_search_fts
				JOIN entries e ON e.rowid = session_search_fts.rowid
				JOIN sessions s ON s.session_id = e.session_id
				WHERE session_search_fts MATCH ?
				${projSql}
				ORDER BY score, e.rowid
				LIMIT ? OFFSET ?`,
		);
		const rows = stmt.all(phrase, ...projArgs, limit, offset) as Array<{
			session_id: string;
			role: string;
			ts: number;
			text: string;
			cwd: string;
			session_name: string | null;
			score: number;
		}>;
		const projectHome = options.projectHome;
		const seenSessions = new Set<string>();
		const hits: SearchHit[] = [];
		for (const row of rows) {
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
				rank: row.score,
				...(firstInSession && row.session_name ? { sessionName: row.session_name } : {}),
			});
		}
		return {
			hits,
			sessionsIndexed,
			sessionsMatched: seenSessions.size,
			queryTooShort: false,
			outOfRange: offset > 0 && hits.length === 0,
		};
	} finally {
		db.close();
	}
}

/** Browse the newest sessions (discovery mode), project-scoped like search. */
export function listRecentSessions(options: BrowseOptions): BrowseEntry[] {
	const db = openIndexDb(options.indexPath);
	try {
		reconcileIndex(db, options.sessionsDir, options.readdir);
		const { sql: projSql, args: projArgs } = projectPredicate(options.scope, options.projectRoot);
		const limit = Math.max(1, Math.min(options.limit ?? 10, 25));
		const rows = db
			.prepare(
				`SELECT session_id, cwd, session_name, first_message, modified
				 FROM sessions s
				 WHERE 1=1 ${projSql}
				 ORDER BY modified DESC
				 LIMIT ?`,
			)
			.all(...projArgs, limit) as Array<{
			session_id: string;
			cwd: string;
			session_name: string | null;
			first_message: string;
			modified: number;
		}>;
		return rows.map((r) => ({
			sessionId: r.session_id,
			shortId: r.session_id.slice(0, 7),
			cwd: r.cwd,
			projectLabel: projectLabelForCwd(r.cwd, options.projectHome),
			firstMessage: r.first_message.slice(0, 160),
			modified: r.modified,
			...(r.session_name ? { sessionName: r.session_name } : {}),
		}));
	} finally {
		db.close();
	}
}
