/**
 * Override-rate storage for the axiom ledger (port #1).
 *
 * Reads `~/.axiom/ledger.json` (path injectable):
 *   { "overrides": { "deepseek/deepseek-chat": { "input": 0.28, "output": 0.42, "cacheRead": 0.028, "cacheWrite": 0.28 } } }
 *
 * The ledger never crashes on a bad file: a missing or malformed file is an
 * empty override map (recorded costs stand).
 */

import { readFileSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { OverrideRates } from "./ledger.js";

/** The parsed `~/.axiom/ledger.json` configuration. */
export interface LedgerConfig {
	overrides: Map<string, OverrideRates>;
	/** Per-run USD spend cap (ADR-0011): absent = no cap, 0 = no LLM calls. */
	maxRunCostUsd?: number;
}

/**
 * Read the full ledger config (overrides + spend cap) from one file:
 *   { "maxRunCostUsd": 0.5, "overrides": { "p/m": { ... } } }
 * Missing or malformed fields are ignored — the ledger never crashes on a
 * bad file, and never invents a cap.
 */
/** Parse raw ledger.json text into a config (never throws on a bad shape). */
export function parseLedgerConfig(raw: string): LedgerConfig {
	const config: LedgerConfig = { overrides: new Map<string, OverrideRates>() };
	const parsed: unknown = JSON.parse(raw);
	if (parsed === null || typeof parsed !== "object") return config;
	const record = parsed as Record<string, unknown>;
	const cap = record.maxRunCostUsd;
	if (typeof cap === "number" && Number.isFinite(cap)) {
		config.maxRunCostUsd = cap;
	}
	const overrides = record.overrides;
	if (overrides === null || typeof overrides !== "object") return config;
	for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
		if (value === null || typeof value !== "object") continue;
		const rates = value as Record<string, unknown>;
		const input = Number(rates.input);
		const output = Number(rates.output);
		const cacheRead = Number(rates.cacheRead);
		const cacheWrite = Number(rates.cacheWrite);
		if ([input, output, cacheRead, cacheWrite].every(Number.isFinite)) {
			config.overrides.set(key, { input, output, cacheRead, cacheWrite });
		}
	}
	return config;
}

/** Sync variant for gateway commands (the command surface is synchronous). */
export function loadLedgerConfigSync(path: string): LedgerConfig {
	try {
		return parseLedgerConfig(readFileSync(path, "utf8"));
	} catch {
		return { overrides: new Map<string, OverrideRates>() };
	}
}

/** Async variant (the extension surfaces). Never throws on a bad file. */
export async function loadLedgerConfig(path: string): Promise<LedgerConfig> {
	try {
		return parseLedgerConfig(await readFile(path, "utf8"));
	} catch {
		return { overrides: new Map<string, OverrideRates>() };
	}
}

/** Override rates only (kept for callers that do not need the cap). */
export async function loadOverrides(path: string): Promise<Map<string, OverrideRates>> {
	return (await loadLedgerConfig(path)).overrides;
}

/** The parsed outcome of a `/cap` argument. */
export type CapArgResult =
	| { kind: "show" }
	| { kind: "set"; usd: number }
	| { kind: "clear" }
	| { kind: "error"; message: string };

/**
 * Parse the `/cap` command argument. Accepts a finite non-negative number
 * (0 disables LLM calls), `none` (clear the cap), or nothing (show).
 * Negatives and garbage are rejected — `shouldBlockRun` treats any cap
 * `<= 0` as "disable all LLM calls", so `/cap -1` must not silently disable.
 */
export function parseCapArg(arg: string): CapArgResult {
	const trimmed = arg.trim();
	if (trimmed === "") return { kind: "show" };
	if (trimmed === "none") return { kind: "clear" };
	const usd = Number(trimmed);
	if (!Number.isFinite(usd) || usd < 0) {
		return { kind: "error", message: `invalid cap '${trimmed}' — use a non-negative number, 'none', or nothing` };
	}
	return { kind: "set", usd };
}

/**
 * Write the ledger config atomically (tmp + rename, the FileMemoryStore
 * discipline) so a crash mid-write cannot corrupt hand-edited overrides.
 */
export async function writeLedgerConfig(path: string, config: LedgerConfig): Promise<void> {
	const payload: Record<string, unknown> = {};
	if (config.maxRunCostUsd !== undefined) {
		payload.maxRunCostUsd = config.maxRunCostUsd;
	}
	if (config.overrides.size > 0) {
		payload.overrides = Object.fromEntries(config.overrides);
	}
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
	await rm(path, { force: true });
	await rename(tmp, path);
}
