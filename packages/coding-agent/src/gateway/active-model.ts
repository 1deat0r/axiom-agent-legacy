/**
 * Active-model store for the gateway /model command (hotswap): persists the
 * operator's chosen provider+model per profile so the gateway can inject
 * `--provider/--model` into every subsequent agent completion — without a
 * restart. Lives under <AXIOM_HOME>/gateway/ (like the ledger and config),
 * keyed by profile so each profile keeps its own model selection. Strictly
 * erasable TypeScript, top-level imports only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A resolved provider + model the gateway will force on the next completion. */
export interface ActiveModel {
	provider: string;
	model: string;
}

/** Persistence boundary (tests inject an in-memory store). */
export interface ActiveModelStore {
	load(): ActiveModel | undefined;
	save(active: ActiveModel): void;
	clear(): void;
}

/** The per-profile model file under the AXIOM gateway dir. */
export function activeModelPath(axiomHomeDir: string, profile: string): string {
	const safe = profile.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
	return join(axiomHomeDir, "gateway", `model-${safe}.json`);
}

/** Human-readable form of the active model ("provider model"). */
export function formatActiveModel(active: ActiveModel): string {
	return `${active.provider} ${active.model}`;
}

/**
 * Parse the `/model <...>` argument into a provider+model pair. Accepted
 * shapes: "provider model", "provider/model", or "provider:model". Returns
 * undefined for empty/ambiguous input so the command can show usage.
 */
export function parseModelArg(arg: string): ActiveModel | undefined {
	const trimmed = arg.trim();
	if (!trimmed) return undefined;
	if (trimmed.includes("/")) {
		const i = trimmed.indexOf("/");
		const provider = trimmed.slice(0, i).trim();
		const model = trimmed.slice(i + 1).trim();
		return provider && model ? { provider, model } : undefined;
	}
	if (trimmed.includes(":")) {
		const i = trimmed.indexOf(":");
		const provider = trimmed.slice(0, i).trim();
		const model = trimmed.slice(i + 1).trim();
		return provider && model ? { provider, model } : undefined;
	}
	const parts = trimmed.split(/\s+/).filter((p) => p.length > 0);
	if (parts.length === 2) {
		return { provider: parts[0], model: parts[1] };
	}
	if (parts.length === 1) {
		// "/model model" only (no provider): leave provider empty to mean "keep
		// the profile's provider" — the CLI resolves the model against it.
		return { provider: "", model: parts[0] };
	}
	return undefined;
}

/** Json-backed store; a missing/malformed file loads as "none set". */
export class FileActiveModelStore implements ActiveModelStore {
	constructor(private readonly path: string) {}
	load(): ActiveModel | undefined {
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ActiveModel>;
			if (typeof raw.provider === "string" && typeof raw.model === "string" && raw.provider && raw.model) {
				return { provider: raw.provider, model: raw.model };
			}
			return undefined;
		} catch {
			return undefined;
		}
	}
	save(active: ActiveModel): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify(active), "utf8");
	}
	clear(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify({}), "utf8");
	}
}

/** In-memory store (tests); stays unset until save(). */
export class InMemoryActiveModelStore implements ActiveModelStore {
	private value: ActiveModel | undefined;
	load(): ActiveModel | undefined {
		return this.value;
	}
	save(active: ActiveModel): void {
		this.value = active;
	}
	clear(): void {
		this.value = undefined;
	}
}
