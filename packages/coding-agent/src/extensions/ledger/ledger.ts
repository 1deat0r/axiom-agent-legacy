/**
 * The axiom cost ledger (port #1, ADR-0010 on the pi baseline).
 *
 * Pure, UI-free core: derives spend from the recorded session entries pi
 * already persists (the stored session is the truth), and reprices with the
 * axiom precedence — entry override rates, else the cost the provider
 * recorded from the catalog. The ledger never invents spend: it prices only
 * recorded tokens, and says so when a model has no catalog price.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../../core/session-manager.ts";

/** Per-1M-token USD rates for one model (the override shape). */
export interface OverrideRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Accumulated token + cost totals for a session or a lifetime. */
export interface LedgerTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** One priced bucket of usage: keyed like pi's usage breakdown. */
export interface CostBucket {
	key: string;
	usage: Usage;
	/** The cost pi recorded for this bucket at request time. */
	recordedCost: number;
}

export function emptyTotals(): LedgerTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addTotals(a: LedgerTotals, b: LedgerTotals): LedgerTotals {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
	};
}

function mergeUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0) || undefined,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

/**
 * Aggregate recorded usage from session entries into per-model buckets,
 * mirroring pi's usage-breakdown keying (assistant usage under
 * `provider/model`, tool results and compaction/summary usage under
 * `Tools/summaries`). Repeated keys merge into one bucket.
 */
export function aggregateUsage(entries: SessionEntry[]): CostBucket[] {
	const buckets: CostBucket[] = [];
	for (const entry of entries) {
		let key: string | undefined;
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = entry.message.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			key = "Tools/summaries";
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			key = "Tools/summaries";
			usage = entry.usage;
		}
		if (!key || !usage) continue;
		buckets.push({ key, usage: mergeUsage(usage, emptyUsage()), recordedCost: usage.cost.total });
	}
	return mergeBuckets(buckets);
}

/** Merge repeated keys into one bucket (tokens and recorded cost summed). */
export function mergeBuckets(buckets: CostBucket[]): CostBucket[] {
	const byKey = new Map<string, CostBucket>();
	for (const bucket of buckets) {
		const existing = byKey.get(bucket.key);
		if (existing) {
			existing.usage = mergeUsage(existing.usage, bucket.usage);
			existing.recordedCost += bucket.recordedCost;
		} else {
			byKey.set(bucket.key, { ...bucket });
		}
	}
	return [...byKey.values()];
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** True when the usage carries any tokens at all. */
function hasTokens(usage: Usage): boolean {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
}

/**
 * Price one usage record at per-1M rates, mirroring pi's `calculateCost`
 * semantics: Anthropic-style 1h cache writes price at 2x the input rate.
 */
export function priceUsage(usage: Usage, rates: OverrideRates): Usage["cost"] {
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	const input = (rates.input / 1_000_000) * usage.input;
	const output = (rates.output / 1_000_000) * usage.output;
	const cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead;
	const cacheWrite = (rates.cacheWrite / 1_000_000) * shortWrite + (rates.input * 2 * longWrite) / 1_000_000;
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/**
 * Apply the override precedence to a set of buckets: an override reprices
 * the bucket from its recorded tokens; otherwise the recorded cost stands.
 * Notes report every deviation the user should see (repriced, or priced at
 * $0 because the model has no catalog price).
 */
export function applyOverrides(
	buckets: CostBucket[],
	overrides: ReadonlyMap<string, OverrideRates>,
): { totals: LedgerTotals; notes: string[] } {
	const totals = emptyTotals();
	const notes: string[] = [];
	for (const bucket of buckets) {
		totals.input += bucket.usage.input;
		totals.output += bucket.usage.output;
		totals.cacheRead += bucket.usage.cacheRead;
		totals.cacheWrite += bucket.usage.cacheWrite;
		const override = overrides.get(bucket.key);
		if (override) {
			totals.cost += priceUsage(bucket.usage, override).total;
			notes.push(`${bucket.key} repriced at override rates`);
		} else {
			totals.cost += bucket.recordedCost;
			if (bucket.recordedCost === 0 && hasTokens(bucket.usage)) {
				notes.push(`${bucket.key}: no catalog price (recorded ${formatUsd(0)})`);
			}
		}
	}
	return { totals, notes };
}

/** Lifetime totals across session bundles, overrides applied once per model. */
export function computeLifetime(
	bundles: Array<{ path: string; entries: SessionEntry[] }>,
	overrides: ReadonlyMap<string, OverrideRates>,
): { totals: LedgerTotals; notes: string[] } {
	const all: CostBucket[] = [];
	for (const bundle of bundles) {
		all.push(...aggregateUsage(bundle.entries));
	}
	return applyOverrides(mergeBuckets(all), overrides);
}

/**
 * Honest USD formatting: four decimals in the micro-dollar range, two for
 * dollars, and significant digits below $0.0001 — real spend never renders
 * as a misleading $0.0000.
 */
export function formatUsd(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0.0000";
	if (usd >= 1) return `$${usd.toFixed(2)}`;
	if (usd >= 0.0001) return `$${usd.toFixed(4)}`;
	return `$${usd.toPrecision(3).replace(/\.?0+$/, "")}`;
}

/** The one-line /cost report: session, lifetime, and any pricing notes. */
export function buildCostReport(session: LedgerTotals, lifetime: LedgerTotals, notes: string[]): string {
	const parts = [`session ${formatUsd(session.cost)}`, `lifetime ${formatUsd(lifetime.cost)}`];
	if (notes.length > 0) parts.push(notes.join("; "));
	return `cost · ${parts.join(" · ")}`;
}
