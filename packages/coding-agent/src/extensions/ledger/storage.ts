/**
 * Override-rate storage for the axiom ledger (port #1).
 *
 * Reads `~/.axiom/ledger.json` (path injectable):
 *   { "overrides": { "deepseek/deepseek-chat": { "input": 0.28, "output": 0.42, "cacheRead": 0.028, "cacheWrite": 0.28 } } }
 *
 * The ledger never crashes on a bad file: a missing or malformed file is an
 * empty override map (recorded costs stand).
 */

import { readFile } from "node:fs/promises";
import type { OverrideRates } from "./ledger.ts";

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
export async function loadLedgerConfig(path: string): Promise<LedgerConfig> {
	const config: LedgerConfig = { overrides: new Map<string, OverrideRates>() };
	try {
		const raw = await readFile(path, "utf8");
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
	} catch {
		// Missing or malformed file: no cap, recorded costs stand.
	}
	return config;
}

/** Override rates only (kept for callers that do not need the cap). */
export async function loadOverrides(path: string): Promise<Map<string, OverrideRates>> {
	return (await loadLedgerConfig(path)).overrides;
}
