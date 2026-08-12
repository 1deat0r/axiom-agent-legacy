/**
 * Channel resume index (ADR-0006): persistent channelId -> sessionId mapping
 * so restarts re-attach in O(1). Written on every mapping; stale entries are
 * dropped when a session id no longer exists. In-memory + JSON-file variants.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ChannelIndex {
	get(channelId: string): string | null;
	/** resolve on a hit with a live target, null on a stale/missing entry */
	has(channelId: string): boolean;
	set(channelId: string, sessionId: string): void;
	remove(channelId: string): void;
}

export class MemoryChannelIndex implements ChannelIndex {
	private readonly map = new Map<string, string>();
	get(channelId: string): string | null {
		return this.map.get(channelId) ?? null;
	}
	has(channelId: string): boolean {
		return this.map.has(channelId);
	}
	set(channelId: string, sessionId: string): void {
		this.map.set(channelId, sessionId);
	}
	remove(channelId: string): void {
		this.map.delete(channelId);
	}
}

/** JSON-file index with atomic rename writes + optimistic stale-drop. */
export class JsonChannelIndex implements ChannelIndex {
	private readonly filePath: string;
	private readonly map: Map<string, string>;
	constructor(dir: string, initial?: Map<string, string>) {
		this.filePath = join(dir, "channels.json");
		this.map = initial ?? new Map();
		if (initial === undefined) {
			try {
				const data = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, string>;
				for (const [k, v] of Object.entries(data)) this.map.set(k, v);
			} catch {
				// Missing or malformed index -> start empty (self-repairing).
			}
		}
	}
	get(channelId: string): string | null {
		return this.map.get(channelId) ?? null;
	}
	has(channelId: string): boolean {
		return this.map.has(channelId);
	}
	set(channelId: string, sessionId: string): void {
		this.map.set(channelId, sessionId);
		this.persist();
	}
	remove(channelId: string): void {
		this.map.delete(channelId);
		this.persist();
	}
	private persist(): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.tmp`;
		writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2), "utf8");
		// Atomic-ish rename; stale index tolerated + self-repairing (ADR-0006).
		rmSync(this.filePath, { force: true });
		// Use copy to avoid cross-platform rename issues in tests; fine for a
		// single writer under the profile home.
		writeFileSync(this.filePath, readFileSync(tmp));
		rmSync(tmp, { force: true });
	}
}
