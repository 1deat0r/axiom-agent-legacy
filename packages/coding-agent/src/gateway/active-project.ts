/**
 * Per-channel active-project store (gateway live project switching).
 *
 * Each chat channel may pick an active project via `/projects use <name>`.
 * The store persists channelId -> project under the profile home so the
 * mapping survives restarts, and tracks a monotonic GENERATION per project:
 * `/projects rm` bumps the generation, so a re-created project derives NEW
 * session ids (the deterministic FNV session hash would otherwise resume the
 * pre-rm conversation from its surviving session file).
 *
 * Persistence precedent: cron-jobs.json (getCronJobsPath(projectHome)); the
 * channel index (channels.json) lives under <axiomHome>/gateway and is a
 * different store.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The store file name under the profile home. */
export const ACTIVE_PROJECTS_FILE = "active-projects.json";

/** Project-name grammar: lowercase a-z0-9 and dashes (shared with /projects). */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Whether a stored project name is safe to resolve (guards hand-edited store files). */
export function isValidProjectName(name: string): boolean {
	return PROJECT_NAME_RE.test(name);
}

/** Per-channel active-project state: which project a chat runs anchored to. */
export interface ActiveProjectStore {
	get(channelId: string): string | undefined;
	set(channelId: string, project: string): void;
	clear(channelId: string): void;
	/** Monotonic per-project generation; bumped by removeProject. */
	generation(project: string): number;
	/**
	 * Remove every channel mapping to `project` and bump its generation in one
	 * write — the "sessions die with the project" rule: a re-created project
	 * starts fresh conversations.
	 */
	removeProject(project: string): void;
}

interface StoreData {
	channels: Record<string, string>;
	generations: Record<string, number>;
}

/** In-memory store for tests and lightweight contexts. */
export class MemoryActiveProjectStore implements ActiveProjectStore {
	private readonly channels = new Map<string, string>();
	private readonly generations = new Map<string, number>();
	get(channelId: string): string | undefined {
		return this.channels.get(channelId);
	}
	set(channelId: string, project: string): void {
		this.channels.set(channelId, project);
	}
	clear(channelId: string): void {
		this.channels.delete(channelId);
	}
	generation(project: string): number {
		return this.generations.get(project) ?? 0;
	}
	removeProject(project: string): void {
		for (const [channel, name] of [...this.channels]) {
			if (name === project) this.channels.delete(channel);
		}
		this.generations.set(project, this.generation(project) + 1);
	}
}

/**
 * JSON-file store under the profile home with atomic rename writes and
 * malformed-file self-heal (a corrupt file starts empty and is repaired on the
 * next write, mirroring JsonChannelIndex's tolerance).
 */
export class FileActiveProjectStore implements ActiveProjectStore {
	private readonly filePath: string;
	private data: StoreData;
	constructor(projectHome: string) {
		this.filePath = join(projectHome, ACTIVE_PROJECTS_FILE);
		this.data = this.load();
	}
	get(channelId: string): string | undefined {
		return this.data.channels[channelId];
	}
	set(channelId: string, project: string): void {
		this.data.channels[channelId] = project;
		this.persist();
	}
	clear(channelId: string): void {
		if (!(channelId in this.data.channels)) return;
		delete this.data.channels[channelId];
		this.persist();
	}
	generation(project: string): number {
		return this.data.generations[project] ?? 0;
	}
	removeProject(project: string): void {
		for (const channel of Object.keys(this.data.channels)) {
			if (this.data.channels[channel] === project) delete this.data.channels[channel];
		}
		// The generation bump alone always matters: a re-created project must
		// derive fresh session ids even when no channel was active on it.
		this.data.generations[project] = this.generation(project) + 1;
		this.persist();
	}
	private load(): StoreData {
		try {
			const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoreData>;
			return {
				channels: raw.channels ?? {},
				generations: raw.generations ?? {},
			};
		} catch {
			return { channels: {}, generations: {} };
		}
	}
	private persist(): void {
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const tmp = `${this.filePath}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.data), "utf8");
		renameSync(tmp, this.filePath);
	}
}

/** The project root a channel's active project anchors to. */
export function resolveProjectRoot(projectHome: string, active: string): string {
	return join(projectHome, "projects", active);
}
