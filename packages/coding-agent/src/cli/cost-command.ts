/**
 * `axiom cost [<session-path>]` — CLI mirror of the gateway /cost command
 * (ADR-0061): prints the session cost report for one session file (default:
 * the newest session in the default sessions dir), with lifetime totals over
 * the sessions directory it lives in. Priced by the same ledger derivation as
 * the extension — recorded tokens only, never invented spend.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getSessionsDir } from "../config.js";
import { loadSessionEntries } from "../extensions/ledger/index.js";
import { aggregateUsage, applyOverrides, buildCostReport, computeLifetime } from "../extensions/ledger/ledger.js";
import { loadLedgerConfigSync } from "../extensions/ledger/storage.js";

const SESSION_FILE_PATTERN = /\.jsonl(?:\.archived-\d+)?$/;

export interface CostCommandDeps {
	/** Directory to scan for sessions (default: the agent home sessions dir). */
	sessionsDir?: string;
	/** Ledger config path (default: <agent home>/ledger.json). */
	ledgerPath?: string;
	/** Write sink (tests). */
	write?: (line: string) => void;
}

/** The newest session file in a directory (live files before archives). */
export function newestSessionFile(sessionsDir: string): string | undefined {
	const live: string[] = [];
	const archived: string[] = [];
	for (const name of readdirSync(sessionsDir)) {
		if (!SESSION_FILE_PATTERN.test(name)) continue;
		const path = join(sessionsDir, name);
		if (name.includes(".archived-")) archived.push(path);
		else live.push(path);
	}
	const pool = live.length > 0 ? live : archived;
	if (pool.length === 0) return undefined;
	return pool.sort((a, b) => a.localeCompare(b)).at(-1);
}

/** Build the cost report for one session file (exported for tests). */
export function buildCostReportForFile(sessionPath: string, sessionsDir: string, ledgerPath: string): string {
	const entries = loadSessionEntries(sessionPath);
	if (entries.length === 0) {
		return "no cost recorded for this session";
	}
	const config = loadLedgerConfigSync(ledgerPath);
	const session = applyOverrides(aggregateUsage(entries), config.overrides);
	const bundles = readdirSync(sessionsDir)
		.filter((name) => SESSION_FILE_PATTERN.test(name))
		.map((name) => join(sessionsDir, name))
		.map((path) => ({ path, entries: loadSessionEntries(path) }));
	const lifetime = computeLifetime(bundles, config.overrides);
	return buildCostReport(session.totals, lifetime.totals, [...session.notes, ...lifetime.notes], {
		buckets: session.rows,
		capUsd: config.maxRunCostUsd,
	});
}

export async function handleCostCommand(args: readonly string[], deps: CostCommandDeps = {}): Promise<boolean> {
	if (args[0] !== "cost") return false;
	const write = deps.write ?? ((line: string) => console.log(line));
	const agentDir = getAgentDir();
	const sessionsDir = deps.sessionsDir ?? getSessionsDir(agentDir);
	const ledgerPath = deps.ledgerPath ?? join(agentDir, "ledger.json");
	const target = args[1];
	if (target !== undefined && target !== "--help" && target !== "-h") {
		if (!existsSync(target)) {
			write(`no such session file: ${target}`);
			return true;
		}
		write(buildCostReportForFile(target, sessionsDir, ledgerPath));
		return true;
	}
	if (target === "--help" || target === "-h") {
		write("Usage: axiom cost [<session-file>]");
		write("Show the session and lifetime cost report for one session file.");
		write("With no argument, the newest session in the default sessions dir is used.");
		return true;
	}
	const newest = newestSessionFile(sessionsDir);
	if (newest === undefined) {
		write("no sessions found");
		return true;
	}
	write(buildCostReportForFile(newest, sessionsDir, ledgerPath));
	return true;
}
