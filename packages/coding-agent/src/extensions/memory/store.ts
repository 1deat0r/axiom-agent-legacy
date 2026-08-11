/**
 * The axiom memory store (port #7, ADR-0008 on the pi baseline).
 *
 * A faithful port of the from-scratch axiom memory: two scopes (`user`
 * durable facts about the user, `agent` the agent's own notes), JSON-file
 * persistence per scope with atomic writes, and optional per-scope LRU
 * eviction applied on add (ADR-0008).
 *
 * pi has no memory tool at all — this is the "asks twice" fix; per-project
 * scoping lands with projects (ADR-0014, port #9).
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Which side of the conversation an entry belongs to. */
export type MemoryScope = "user" | "agent";

/** A single durable fact persisted across sessions. */
export interface MemoryEntry {
	id: string;
	scope: MemoryScope;
	/** Declarative fact, e.g. "User prefers concise responses". */
	content: string;
	createdAt: number;
	updatedAt: number;
}

/** Where memory lives; the agent core only depends on this interface. */
export interface MemoryStore {
	/** All entries, optionally filtered by scope. Newest first. */
	list(scope?: MemoryScope): Promise<MemoryEntry[]>;
	/**
	 * Add a new entry; returns the persisted entry (id + timestamps) and the
	 * number of stale entries this add evicted (0 when no cap or under it).
	 */
	add(entry: { scope: MemoryScope; content: string }): Promise<{ entry: MemoryEntry; evicted: number }>;
	/** Replace an entry's content; returns the updated entry. */
	update(id: string, content: string): Promise<MemoryEntry>;
	/** Delete an entry by id. */
	remove(id: string): Promise<void>;
}

/**
 * Strictly-monotonic timestamp for entry `updatedAt`/`createdAt`. Wall-clock
 * `Date.now()` can return identical millisecond values for back-to-back adds,
 * which would make LRU eviction non-deterministic; bumping to at least
 * `lastUpdated + 1` across the process keeps the operation order observable
 * (and eviction deterministic) even within a single millisecond.
 */
let lastTimestamp = 0;
function nextTimestamp(): number {
	const now = Date.now();
	lastTimestamp = Math.max(now, lastTimestamp + 1);
	return lastTimestamp;
}

/** Atomic-ish JSON write: temp file then rename (the from-scratch discipline). */
async function atomicWriteJson(path: string, data: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
	await rm(path, { force: true });
	await rename(tmp, path);
}

/**
 * A dependency-free JSON-file memory store.
 *
 * Layout: `<dir>/<scope>.json` — one array of MemoryEntry per scope,
 * atomically written. Eviction (ADR-0008): when constructed with
 * `maxEntriesPerScope`, an add that would push a scope past the cap removes
 * the least-recently-updated entries until the cap holds. Unset = unbounded.
 */
export class FileMemoryStore implements MemoryStore {
	private readonly dir: string;
	private readonly maxEntriesPerScope: number | undefined;

	constructor(dir: string, opts: { maxEntriesPerScope?: number } = {}) {
		this.dir = dir;
		this.maxEntriesPerScope = opts.maxEntriesPerScope;
	}

	private path(scope: MemoryScope): string {
		return join(this.dir, `${scope}.json`);
	}

	private async readScope(scope: MemoryScope): Promise<MemoryEntry[]> {
		try {
			const parsed = JSON.parse(await readFile(this.path(scope), "utf8")) as unknown;
			return Array.isArray(parsed) ? (parsed as MemoryEntry[]) : [];
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
	}

	private async writeScope(scope: MemoryScope, entries: MemoryEntry[]): Promise<void> {
		await atomicWriteJson(this.path(scope), entries);
	}

	async list(scope?: MemoryScope): Promise<MemoryEntry[]> {
		const scopes: MemoryScope[] = scope !== undefined ? [scope] : ["user", "agent"];
		const out: MemoryEntry[] = [];
		for (const s of scopes) {
			out.push(...(await this.readScope(s)));
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async add(entry: { scope: MemoryScope; content: string }): Promise<{ entry: MemoryEntry; evicted: number }> {
		const now = nextTimestamp();
		const full: MemoryEntry = {
			id: randomUUID(),
			scope: entry.scope,
			content: entry.content,
			createdAt: now,
			updatedAt: now,
		};
		const entries = await this.readScope(entry.scope);
		const before = entries.length;
		entries.push(full);
		const surviving = enforceCap(entries, this.maxEntriesPerScope);
		await this.writeScope(entry.scope, surviving);
		return { entry: full, evicted: before + 1 - surviving.length };
	}

	async update(id: string, content: string): Promise<MemoryEntry> {
		for (const scope of ["user", "agent"] as const) {
			const entries = await this.readScope(scope);
			const idx = entries.findIndex((e) => e.id === id);
			if (idx >= 0) {
				const updated: MemoryEntry = { ...entries[idx]!, content, updatedAt: nextTimestamp() };
				entries[idx] = updated;
				await this.writeScope(scope, entries);
				return updated;
			}
		}
		throw new Error(`Memory entry '${id}' not found`);
	}

	async remove(id: string): Promise<void> {
		for (const scope of ["user", "agent"] as const) {
			const entries = await this.readScope(scope);
			const idx = entries.findIndex((e) => e.id === id);
			if (idx >= 0) {
				entries.splice(idx, 1);
				await this.writeScope(scope, entries);
				return;
			}
		}
	}
}

/** In-memory store for tests and embedding (no disk I/O). */
export class InMemoryMemoryStore implements MemoryStore {
	private readonly entries = new Map<string, MemoryEntry>();
	private readonly maxEntriesPerScope: number | undefined;

	constructor(opts: { maxEntriesPerScope?: number } = {}) {
		this.maxEntriesPerScope = opts.maxEntriesPerScope;
	}

	async list(scope?: MemoryScope): Promise<MemoryEntry[]> {
		const all = Array.from(this.entries.values());
		const filtered = scope !== undefined ? all.filter((e) => e.scope === scope) : all;
		return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async add(entry: { scope: MemoryScope; content: string }): Promise<{ entry: MemoryEntry; evicted: number }> {
		const now = nextTimestamp();
		const full: MemoryEntry = {
			id: randomUUID(),
			scope: entry.scope,
			content: entry.content,
			createdAt: now,
			updatedAt: now,
		};
		const before = this.entries.size;
		this.entries.set(full.id, full);
		let evicted = 0;
		if (this.maxEntriesPerScope !== undefined) {
			const scopeEntries = Array.from(this.entries.values()).filter((e) => e.scope === full.scope);
			const survivorIds = new Set(enforceCap(scopeEntries, this.maxEntriesPerScope).map((e) => e.id));
			for (const e of scopeEntries) {
				if (!survivorIds.has(e.id)) this.entries.delete(e.id);
			}
			evicted = before + 1 - this.entries.size;
		}
		return { entry: full, evicted };
	}

	async update(id: string, content: string): Promise<MemoryEntry> {
		const cur = this.entries.get(id);
		if (!cur) throw new Error(`Memory entry '${id}' not found`);
		const updated: MemoryEntry = { ...cur, content, updatedAt: nextTimestamp() };
		this.entries.set(id, updated);
		return updated;
	}

	async remove(id: string): Promise<void> {
		this.entries.delete(id);
	}
}

/**
 * Evict the least-recently-updated entries from a scope's array so its length
 * is at most `cap`. When `cap` is undefined the array is returned unchanged
 * (unbounded). Entries are ordered by `updatedAt` ascending for eviction —
 * we drop the stale tail and keep the freshest `cap`.
 */
function enforceCap(entries: MemoryEntry[], cap: number | undefined): MemoryEntry[] {
	if (cap === undefined || entries.length <= cap) return entries;
	return [...entries].sort((a, b) => a.updatedAt - b.updatedAt).slice(-cap);
}

/**
 * Render the current memory into a system-prompt context block. Kept distinct
 * and delimited so both the agent and a human reader can tell it apart from
 * the base system prompt. Returns '' when there is nothing to inject.
 */
export function memoryContextBlock(entries: MemoryEntry[]): string {
	if (entries.length === 0) return "";
	const lines = entries.map((e) => `- [${e.scope}] ${e.content}`);
	return (
		"\n\n" +
		"<<<memory>>>\n" +
		"Durable facts about this environment and its user, persisted across " +
		"sessions. Treat these as reliable context:\n" +
		lines.join("\n") +
		"\n<</memory>>>\n"
	);
}
