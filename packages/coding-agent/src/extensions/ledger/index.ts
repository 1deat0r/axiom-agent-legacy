/**
 * The axiom ledger extension (port #1, ADR-0010 on the pi baseline).
 *
 * Surfaces the pure ledger core on the extension API:
 *  - `/cost` — session + lifetime spend, override repricing, honest notes.
 *  - `agent_settled` — the footer status shows the live session cost.
 *
 * Dependencies are injectable for tests; defaults read pi's real stores.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import {
	loadEntriesFromFile,
	type SessionEntry,
	type SessionInfo,
	SessionManager,
} from "../../core/session-manager.ts";
import {
	aggregateUsage,
	applyOverrides,
	buildCostReport,
	computeLifetime,
	formatUsd,
	type OverrideRates,
} from "./ledger.ts";
import { loadOverrides as defaultLoadOverrides } from "./storage.ts";

export interface LedgerDeps {
	overridesPath: string;
	loadOverrides(path: string): Promise<Map<string, OverrideRates>>;
	listAllSessions(): Promise<Pick<SessionInfo, "path">[]>;
	loadEntries(path: string): SessionEntry[];
}

const DEFAULT_OVERRIDES_PATH = join(homedir(), ".axiom", "ledger.json");

/** Narrow a session file's entries to session entries (drop the header). */
function loadSessionEntries(path: string): SessionEntry[] {
	return loadEntriesFromFile(path).filter((e): e is SessionEntry => e.type !== "session");
}

/** The real-store defaults, exported so tests can exercise them without IO. */
export function defaultLedgerDeps(): LedgerDeps {
	return {
		overridesPath: DEFAULT_OVERRIDES_PATH,
		loadOverrides: defaultLoadOverrides,
		listAllSessions: () => SessionManager.listAll(),
		loadEntries: (path) => loadSessionEntries(path),
	};
}

export function createLedgerExtension(deps?: Partial<LedgerDeps>): (pi: ExtensionAPI) => void {
	const defaults = defaultLedgerDeps();
	const resolved: LedgerDeps = {
		overridesPath: deps?.overridesPath ?? defaults.overridesPath,
		loadOverrides: deps?.loadOverrides ?? defaults.loadOverrides,
		listAllSessions: deps?.listAllSessions ?? defaults.listAllSessions,
		loadEntries: deps?.loadEntries ?? defaults.loadEntries,
	};
	return (pi: ExtensionAPI) => {
		pi.registerCommand("cost", {
			description: "Show session and lifetime spend",
			handler: async (_args, ctx) => {
				const overrides = await resolved.loadOverrides(resolved.overridesPath);
				const session = applyOverrides(aggregateUsage(ctx.sessionManager.getEntries()), overrides);
				const sessions = await resolved.listAllSessions();
				const bundles = sessions.map((s) => ({ path: s.path, entries: resolved.loadEntries(s.path) }));
				const lifetime = computeLifetime(bundles, overrides);
				const report = buildCostReport(session.totals, lifetime.totals, [...session.notes, ...lifetime.notes]);
				ctx.ui.notify(report);
			},
		});
		pi.on("agent_settled", async (_event, ctx) => {
			const overrides = await resolved.loadOverrides(resolved.overridesPath);
			const { totals } = applyOverrides(aggregateUsage(ctx.sessionManager.getEntries()), overrides);
			ctx.ui.setStatus("axiom.cost", formatUsd(totals.cost));
		});
	};
}

export default function axiomLedgerExtension(pi: ExtensionAPI): void {
	createLedgerExtension()(pi);
}
