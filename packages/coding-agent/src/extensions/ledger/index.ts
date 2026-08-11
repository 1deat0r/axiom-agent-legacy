/**
 * The axiom ledger extension (ports #1 and #2, ADR-0010/0011 on the pi
 * baseline).
 *
 * Surfaces the pure ledger core on the extension API:
 *  - `/cost` — session + lifetime spend, override repricing, honest notes.
 *  - `agent_settled` — the footer status shows the live session cost.
 *  - the spend cap — run spend accumulates per turn; `turn_start` (which
 *    fires before every provider call) aborts the run once the cap is hit,
 *    so the loop stops before the next LLM call.
 *
 * Dependencies are injectable for tests; defaults read pi's real stores.
 */

import { join } from "node:path";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import {
	loadEntriesFromFile,
	type SessionEntry,
	type SessionInfo,
	SessionManager,
} from "../../core/session-manager.ts";
import { axiomHome } from "../profile/registry.ts";
import {
	aggregateUsage,
	applyOverrides,
	bucketFromAssistantMessage,
	buildCostReport,
	type CostBucket,
	computeLifetime,
	formatUsd,
	mergeBuckets,
	shouldBlockRun,
} from "./ledger.ts";
import type { LedgerConfig } from "./storage.ts";
import { loadLedgerConfig as defaultLoadConfig, parseCapArg, writeLedgerConfig } from "./storage.ts";

export interface LedgerDeps {
	overridesPath: string;
	loadConfig(path: string): Promise<LedgerConfig>;
	listAllSessions(): Promise<Pick<SessionInfo, "path">[]>;
	loadEntries(path: string): SessionEntry[];
}

/** The active home's ledger file (AXIOM_HOME, default ~/.axiom). */
function defaultOverridesPath(): string {
	return join(axiomHome(), "ledger.json");
}

/** Narrow a session file's entries to session entries (drop the header). */
function loadSessionEntries(path: string): SessionEntry[] {
	return loadEntriesFromFile(path).filter((e): e is SessionEntry => e.type !== "session");
}

/** The real-store defaults, exported so tests can exercise them without IO. */
export function defaultLedgerDeps(): LedgerDeps {
	return {
		overridesPath: defaultOverridesPath(),
		loadConfig: defaultLoadConfig,
		listAllSessions: () => SessionManager.listAll(),
		loadEntries: (path) => loadSessionEntries(path),
	};
}

export function createLedgerExtension(deps?: Partial<LedgerDeps>): (pi: ExtensionAPI) => void {
	const defaults = defaultLedgerDeps();
	const resolved: LedgerDeps = {
		overridesPath: deps?.overridesPath ?? defaults.overridesPath,
		loadConfig: deps?.loadConfig ?? defaults.loadConfig,
		listAllSessions: deps?.listAllSessions ?? defaults.listAllSessions,
		loadEntries: deps?.loadEntries ?? defaults.loadEntries,
	};
	return (pi: ExtensionAPI) => {
		pi.registerCommand("cost", {
			description: "Show session and lifetime spend",
			handler: async (_args, ctx) => {
				const config = await resolved.loadConfig(resolved.overridesPath);
				const session = applyOverrides(aggregateUsage(ctx.sessionManager.getEntries()), config.overrides);
				const sessions = await resolved.listAllSessions();
				const bundles = sessions.map((s) => ({ path: s.path, entries: resolved.loadEntries(s.path) }));
				const lifetime = computeLifetime(bundles, config.overrides);
				const report = buildCostReport(session.totals, lifetime.totals, [...session.notes, ...lifetime.notes], {
					buckets: session.rows,
					capUsd: config.maxRunCostUsd,
				});
				ctx.ui.notify(report);
			},
		});
		pi.registerCommand("cap", {
			description: "Show or set the per-run spend cap (/cap <usd> | none)",
			handler: async (args, ctx) => {
				const parsed = parseCapArg(args);
				if (parsed.kind === "error") {
					ctx.ui.notify(parsed.message, "error");
					return;
				}
				const config = await resolved.loadConfig(resolved.overridesPath);
				if (parsed.kind === "set") {
					await writeLedgerConfig(resolved.overridesPath, { ...config, maxRunCostUsd: parsed.usd });
					ctx.ui.notify(
						parsed.usd === 0
							? "cap set to $0.0000 — LLM calls disabled (run /cap none to re-enable)"
							: `cap set to ${formatUsd(parsed.usd)}`,
					);
					return;
				}
				if (parsed.kind === "clear") {
					const next: LedgerConfig = { overrides: config.overrides };
					await writeLedgerConfig(resolved.overridesPath, next);
					ctx.ui.notify("cap cleared — runs are uncapped");
					return;
				}
				// show: cap + session + lifetime headroom
				const session = applyOverrides(aggregateUsage(ctx.sessionManager.getEntries()), config.overrides);
				const sessions = await resolved.listAllSessions();
				const bundles = sessions.map((s) => ({ path: s.path, entries: resolved.loadEntries(s.path) }));
				const lifetime = computeLifetime(bundles, config.overrides);
				const capText = config.maxRunCostUsd !== undefined ? `cap ${formatUsd(config.maxRunCostUsd)}` : "no cap";
				ctx.ui.notify(
					`${capText} · session ${formatUsd(session.totals.cost)} · lifetime ${formatUsd(lifetime.totals.cost)}`,
				);
			},
		});
		pi.on("agent_settled", async (_event, ctx) => {
			const { overrides } = await resolved.loadConfig(resolved.overridesPath);
			const { totals } = applyOverrides(aggregateUsage(ctx.sessionManager.getEntries()), overrides);
			ctx.ui.setStatus("axiom.cost", formatUsd(totals.cost));
		});

		// The spend cap (ADR-0011): per-run spend accumulates from turn_end
		// (each assistant response carries its usage); turn_start fires
		// before every provider call, so aborting there stops the loop
		// before the next LLM call.
		let runBuckets: CostBucket[] = [];
		pi.on("agent_start", () => {
			runBuckets = [];
		});
		pi.on("turn_end", (event, _ctx) => {
			const message = event.message;
			if (message.role !== "assistant" || !message.usage) return;
			runBuckets = mergeBuckets([...runBuckets, bucketFromAssistantMessage(message)]);
		});
		pi.on("turn_start", async (_event, ctx) => {
			const config = await resolved.loadConfig(resolved.overridesPath);
			if (config.maxRunCostUsd === undefined) return;
			const { totals } = applyOverrides(mergeBuckets(runBuckets), config.overrides);
			if (!shouldBlockRun(config.maxRunCostUsd, totals.cost)) return;
			if (config.maxRunCostUsd <= 0) {
				ctx.ui.notify("cost cap is 0 — LLM calls disabled (run /cap none to re-enable)", "warning");
			} else {
				ctx.ui.notify(
					`cost cap ${formatUsd(config.maxRunCostUsd)} reached (${formatUsd(totals.cost)}) — run stopped. ` +
						`Run /cost to review, /cap to adjust.`,
					"warning",
				);
			}
			ctx.abort();
		});
	};
}

export default function axiomLedgerExtension(pi: ExtensionAPI): void {
	createLedgerExtension()(pi);
}
