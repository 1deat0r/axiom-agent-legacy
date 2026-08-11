/**
 * The axiom cost ledger (port #1, ADR-0010 on the pi baseline).
 *
 * Pure, UI-free core: derives spend from the recorded session entries pi
 * already persists (the stored session is the truth), and reprices with the
 * axiom precedence — entry override rates, else the cost the provider
 * recorded from the catalog. The ledger never invents spend: it prices only
 * recorded tokens, and says so when a model has no catalog price.
 */

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../../core/session-manager.js";

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
 * Price one usage record at per-1M rates, mirroring the baseline's
 * `calculateCost` semantics: every cacheWrite token prices at the cacheWrite
 * rate (v0.7.2 has no 1h cache-write tier).
 */
export function priceUsage(usage: Usage, rates: OverrideRates): Usage["cost"] {
	const input = (rates.input / 1_000_000) * usage.input;
	const output = (rates.output / 1_000_000) * usage.output;
	const cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead;
	const cacheWrite = (rates.cacheWrite / 1_000_000) * usage.cacheWrite;
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
): { totals: LedgerTotals; notes: string[]; rows: Array<{ key: string; cost: number }> } {
	const totals = emptyTotals();
	const notes: string[] = [];
	const rows: Array<{ key: string; cost: number }> = [];
	for (const bucket of buckets) {
		totals.input += bucket.usage.input;
		totals.output += bucket.usage.output;
		totals.cacheRead += bucket.usage.cacheRead;
		totals.cacheWrite += bucket.usage.cacheWrite;
		const override = overrides.get(bucket.key);
		if (override) {
			const cost = priceUsage(bucket.usage, override).total;
			totals.cost += cost;
			rows.push({ key: bucket.key, cost });
			notes.push(`${bucket.key} repriced at override rates`);
		} else {
			totals.cost += bucket.recordedCost;
			rows.push({ key: bucket.key, cost: bucket.recordedCost });
			if (bucket.recordedCost === 0 && hasTokens(bucket.usage)) {
				notes.push(`${bucket.key}: no catalog price (recorded ${formatUsd(0)})`);
			}
		}
	}
	return { totals, notes, rows };
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
 * The spend-cap decision (ADR-0011): whether the next LLM call must be
 * blocked. `undefined` cap never blocks; `0` (or negative) disables LLM
 * calls entirely; a positive cap blocks once the run's recorded spend
 * reaches it. A zero-cost run never trips a positive cap — only
 * usage-reporting providers can trip it.
 */
export function shouldBlockRun(capUsd: number | undefined, runCostUsd: number): boolean {
	if (capUsd === undefined) return false;
	if (capUsd <= 0) return true;
	return runCostUsd >= capUsd;
}

/** One assistant response as a ledger bucket (the per-run accumulation unit). */
export function bucketFromAssistantMessage(
	message: Pick<AssistantMessage, "provider" | "model" | "responseModel" | "usage">,
): CostBucket {
	return {
		key: `${message.provider}/${message.responseModel ?? message.model}`,
		usage: message.usage,
		recordedCost: message.usage.cost.total,
	};
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

/** Optional detail for the /cost report (additive — the 3-arg call still works). */
export interface CostReportOptions {
	/** Per-model rows for the top buckets (bounded with an explicit overflow note). */
	buckets?: Array<{ key: string; cost: number }>;
	/** Render the cap line only when a cap is actually set. */
	capUsd?: number;
}

const MAX_MODEL_ROWS = 3;

/** The one-line /cost report: session, lifetime, cap (when set), notes, and
 * the top per-model rows — never silently truncated, so an overflow is
 * named. */
export function buildCostReport(
	session: LedgerTotals,
	lifetime: LedgerTotals,
	notes: string[],
	opts: CostReportOptions = {},
): string {
	const parts = [`session ${formatUsd(session.cost)}`, `lifetime ${formatUsd(lifetime.cost)}`];
	if (opts.capUsd !== undefined) parts.push(`cap ${formatUsd(opts.capUsd)}`);
	if (notes.length > 0) parts.push(notes.join("; "));
	if (opts.buckets && opts.buckets.length > 0) {
		const rows = [...opts.buckets].sort((a, b) => b.cost - a.cost);
		const shown = rows.slice(0, MAX_MODEL_ROWS);
		for (const bucket of shown) {
			parts.push(`${bucket.key} ${formatUsd(bucket.cost)}`);
		}
		const hidden = rows.length - shown.length;
		if (hidden > 0) parts.push(`+${hidden} more models`);
	}
	return `cost · ${parts.join(" · ")}`;
}
