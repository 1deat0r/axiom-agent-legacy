/**
 * Gateway /cost command (ADR-0061): shows the channel's session cost and the
 * lifetime cost across every gateway session, priced by the same ledger
 * derivation the session /cost uses (recorded tokens only — the ledger never
 * invents spend). The channel session key follows the run path: channel-only
 * when unanchored, channel:project:generation when the channel has an active
 * project. Overhead (HTTP, streaming) is not priced — it costs nothing
 * measurable, and the money thesis forbids synthetic fees.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadSessionEntries } from "../../extensions/ledger/index.js";
import { aggregateUsage, applyOverrides, buildCostReport, computeLifetime } from "../../extensions/ledger/ledger.js";
import { loadLedgerConfigSync } from "../../extensions/ledger/storage.js";
import { sessionFilePath } from "../session-reset.js";
import type { GatewayCommand, GatewayCommandContext } from "../types.js";

/** Live sessions plus archived ones (a /new archive still holds cost). */
const SESSION_FILE_PATTERN = /\.jsonl(?:\.archived-\d+)?$/;

function channelSessionKey(ctx: GatewayCommandContext): string | undefined {
	if (ctx.channelId === undefined) return undefined;
	if (ctx.activeProject !== undefined && ctx.activeProjects !== undefined) {
		return `${ctx.channelId}:${ctx.activeProject}:${ctx.activeProjects.generation(ctx.activeProject)}`;
	}
	return ctx.channelId;
}

function lifetimeBundles(sessionsDir: string): Array<{ path: string; entries: ReturnType<typeof loadSessionEntries> }> {
	return readdirSync(sessionsDir)
		.filter((name) => SESSION_FILE_PATTERN.test(name))
		.map((name) => join(sessionsDir, name))
		.map((path) => ({ path, entries: loadSessionEntries(path) }));
}

/** Build the /cost report for one command context (exported for tests). */
export function buildGatewayCostReport(ctx: GatewayCommandContext): string {
	if (!ctx.sessionsDir) return "sessions directory is not configured";
	const key = channelSessionKey(ctx);
	if (key === undefined) return "channel is not identified";
	const path = sessionFilePath(ctx.sessionsDir, key);
	const entries = loadSessionEntries(path);
	if (entries.length === 0) {
		return "no cost recorded for this channel yet";
	}
	const config = loadLedgerConfigSync(join(ctx.axiomHomeDir, "ledger.json"));
	const session = applyOverrides(aggregateUsage(entries), config.overrides);
	const bundles = lifetimeBundles(ctx.sessionsDir);
	const lifetime = computeLifetime(bundles, config.overrides);
	return buildCostReport(session.totals, lifetime.totals, [...session.notes, ...lifetime.notes], {
		buckets: session.rows,
		capUsd: config.maxRunCostUsd,
	});
}

/** `/cost` — channel session and lifetime cost, gateway completions included. */
export const costCommand: GatewayCommand = {
	name: "cost",
	summary: "Show channel session and lifetime cost (gateway completions included)",
	handler(_args, ctx) {
		try {
			return buildGatewayCostReport(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return `could not read cost: ${message}`;
		}
	},
};
