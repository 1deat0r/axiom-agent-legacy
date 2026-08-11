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

export async function loadOverrides(path: string): Promise<Map<string, OverrideRates>> {
	const map = new Map<string, OverrideRates>();
	try {
		const raw = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return map;
		const overrides = (parsed as { overrides?: unknown }).overrides;
		if (overrides === null || typeof overrides !== "object") return map;
		for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
			if (value === null || typeof value !== "object") continue;
			const rates = value as Record<string, unknown>;
			const input = Number(rates.input);
			const output = Number(rates.output);
			const cacheRead = Number(rates.cacheRead);
			const cacheWrite = Number(rates.cacheWrite);
			if ([input, output, cacheRead, cacheWrite].every(Number.isFinite)) {
				map.set(key, { input, output, cacheRead, cacheWrite });
			}
		}
	} catch {
		// Missing or malformed file: recorded costs stand.
	}
	return map;
}
