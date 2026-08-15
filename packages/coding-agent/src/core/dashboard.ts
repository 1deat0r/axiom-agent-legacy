/**
 * The dashboard capability (ADR-0085): a read-only, on-demand, whole-profile
 * report with three panels — sessions, automation spine, spend. One shared
 * aggregation module; the gateway (/dashboard) and the CLI (axiom dashboard)
 * are thin text surfaces over it. Global by design (no project anchoring);
 * per-panel degradation (a missing store renders a one-line notice and the
 * other panels still render); no writes, no cache, no daemon state.
 *
 * Fully synchronous: the gateway command dispatcher is sync, and the CLI
 * needs no awaits either. The sessions panel therefore uses its own focused
 * five-field scan (id, name, activity time, recap, verdict) instead of the
 * async readSessionInfo — the dashboard never needs message contents, and
 * the fields it reads are exactly the ones pinned here.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadSessionEntries } from "../extensions/ledger/index.js";
import { computeLifetime, formatUsd } from "../extensions/ledger/ledger.js";
import { loadLedgerConfigSync } from "../extensions/ledger/storage.js";
import { type AgentCronJob, AgentCronJobStore } from "./cron-jobs.js";

const SESSION_FILE_PATTERN = /\.jsonl(?:\.archived-\d+)?$/;

/** Recent non-live, non-needs-input sessions kept beyond the always-shown ones. */
export const DASHBOARD_RECENT_SESSION_LIMIT = 5;

export interface DashboardDeps {
	sessionsDir?: string;
	cronStorePath?: string;
	ledgerPath?: string;
	/** Session ids this surface knows are live (daemon-attached / running). */
	liveSessionIds?: ReadonlySet<string>;
}

export interface DashboardSessionLine {
	id: string;
	name?: string;
	modified: string;
	recap?: string;
	needsInput: boolean;
	live: boolean;
}

export interface DashboardSpineLine {
	id: string;
	kind: AgentCronJob["schedule"]["kind"];
	scheduleText: string;
	nextRunAt?: string;
	paused: boolean;
}

export interface DashboardPanel<T> {
	lines: T[];
	unavailable?: string;
}

export interface DashboardSpendPanel {
	costUsd: number;
	unavailable?: string;
}

export interface DashboardReport {
	sessions: DashboardPanel<DashboardSessionLine>;
	spine: DashboardPanel<DashboardSpineLine>;
	spend: DashboardSpendPanel;
}

export function buildDashboardReport(deps: DashboardDeps): DashboardReport {
	return {
		sessions: buildSessionsPanel(deps),
		spine: buildSpinePanel(deps),
		spend: buildSpendPanel(deps),
	};
}

interface DashboardSessionEntry {
	type?: unknown;
	id?: unknown;
	name?: unknown;
	status?: unknown;
	timestamp?: unknown;
	message?: unknown;
}

/** Five fields the dashboard needs from a session file; nothing else is parsed. */
function scanSessionForDashboard(filePath: string): Omit<DashboardSessionLine, "live"> | undefined {
	let text: string;
	let mtimeMs = 0;
	try {
		text = readFileSync(filePath, "utf8");
		mtimeMs = statSync(filePath).mtimeMs;
	} catch {
		return undefined;
	}
	let id: string | undefined;
	let name: string | undefined;
	let recap: string | undefined;
	let needsInput = false;
	let activityMs = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: DashboardSessionEntry;
		try {
			entry = JSON.parse(line) as DashboardSessionEntry;
		} catch {
			continue;
		}
		switch (entry.type) {
			case "session":
				if (typeof entry.id === "string") id = entry.id;
				break;
			case "session_info":
				if (typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim();
				break;
			case "agent_status": {
				const status = entry.status as { summary?: unknown; taskState?: unknown } | undefined;
				if (typeof status?.summary === "string") recap = status.summary;
				needsInput = status?.taskState === "needs_input";
				break;
			}
			case "message": {
				const message = entry.message as { role?: unknown; content?: unknown } | undefined;
				if (message?.role !== "user" && message?.role !== "assistant") break;
				if (!Array.isArray(message.content) || message.content.length === 0) break;
				const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
				if (Number.isFinite(timestamp)) activityMs = Math.max(activityMs, timestamp);
				break;
			}
		}
	}
	if (id === undefined) return undefined;
	return {
		id,
		name,
		modified: new Date(activityMs > 0 ? activityMs : mtimeMs).toISOString(),
		recap,
		needsInput,
	};
}

function buildSessionsPanel(deps: DashboardDeps): DashboardPanel<DashboardSessionLine> {
	if (!deps.sessionsDir) {
		return { lines: [], unavailable: "sessions: no sessions directory configured" };
	}
	let names: string[];
	try {
		names = readdirSync(deps.sessionsDir).filter((name) => SESSION_FILE_PATTERN.test(name));
	} catch {
		return { lines: [], unavailable: "sessions: sessions directory is not readable" };
	}
	const lines: DashboardSessionLine[] = [];
	for (const name of names) {
		const scanned = scanSessionForDashboard(join(deps.sessionsDir, name));
		if (!scanned) continue;
		lines.push({ ...scanned, live: deps.liveSessionIds?.has(scanned.id) ?? false });
	}
	// Order: live first, then needs-input, then recency — the daily-driver
	// glance (anything running or stuck first, recent context after).
	const byModifiedDesc = (a: DashboardSessionLine, b: DashboardSessionLine) =>
		Date.parse(b.modified) - Date.parse(a.modified);
	const live = lines.filter((line) => line.live).sort(byModifiedDesc);
	const needsInput = lines.filter((line) => !line.live && line.needsInput).sort(byModifiedDesc);
	const recent = lines.filter((line) => !line.live && !line.needsInput).sort(byModifiedDesc);
	return {
		lines: [...live, ...needsInput, ...recent.slice(0, DASHBOARD_RECENT_SESSION_LIMIT)],
	};
}

function buildSpinePanel(deps: DashboardDeps): DashboardPanel<DashboardSpineLine> {
	if (!deps.cronStorePath) {
		return { lines: [], unavailable: "cron: no cron store configured" };
	}
	const store = new AgentCronJobStore(deps.cronStorePath);
	const lines = store
		.list()
		// The spine is what will happen next: active jobs plus paused ones
		// (flagged); completed and cancelled jobs have no future.
		.filter((job) => job.status === "active" || job.status === "paused")
		.map((job) => ({
			id: job.id,
			kind: job.schedule.kind,
			scheduleText: job.schedule.expression,
			nextRunAt: job.nextRunAt,
			paused: job.status === "paused",
		}));
	return { lines };
}

function buildSpendPanel(deps: DashboardDeps): DashboardSpendPanel {
	if (!deps.sessionsDir) {
		return { costUsd: 0, unavailable: "spend: no sessions directory configured" };
	}
	const sessionsDir = deps.sessionsDir;
	const overrides = loadLedgerConfigSync(deps.ledgerPath ?? join(dirnameOf(sessionsDir), "ledger.json")).overrides;
	const bundles = readdirSync(sessionsDir)
		.filter((name) => SESSION_FILE_PATTERN.test(name))
		.map((name) => join(sessionsDir, name))
		.map((path) => ({ path, entries: loadSessionEntries(path) }));
	const lifetime = computeLifetime(bundles, overrides);
	return { costUsd: lifetime.totals.cost };
}

function dirnameOf(path: string): string {
	const separator = path.lastIndexOf("/");
	return separator < 0 ? "." : path.slice(0, separator);
}

/** Relative "next run" text in the /cron style, anchored to `now`. */
function relativeNext(nextRunAt: string | undefined, now: Date): string {
	if (!nextRunAt) return "paused";
	const ms = Date.parse(nextRunAt) - now.getTime();
	if (Number.isNaN(ms)) return "—";
	if (ms <= 0) return "due now";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `in ~${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `in ~${hours}h`;
	return `in ~${Math.round(hours / 24)}d`;
}

export function renderDashboardText(report: DashboardReport, now = new Date()): string {
	const lines: string[] = ["axiom dashboard", ""];
	lines.push("sessions:");
	if (report.sessions.unavailable) {
		lines.push(`  ${report.sessions.unavailable}`);
	} else if (report.sessions.lines.length === 0) {
		lines.push("  no sessions yet");
	} else {
		for (const session of report.sessions.lines) {
			const flags = [session.live ? "live" : undefined, session.needsInput ? "needs input" : undefined].filter(
				(flag): flag is string => flag !== undefined,
			);
			const recap = session.recap ? ` — ${session.recap}` : "";
			const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
			lines.push(`  • ${session.name ?? session.id}${recap}${suffix}`);
		}
	}
	lines.push("");
	lines.push("spine:");
	if (report.spine.unavailable) {
		lines.push(`  ${report.spine.unavailable}`);
	} else if (report.spine.lines.length === 0) {
		lines.push("  no scheduled jobs");
	} else {
		for (const job of report.spine.lines) {
			const next = relativeNext(job.nextRunAt, now);
			const paused = job.paused ? " (paused)" : "";
			lines.push(`  • ${job.scheduleText} — ${next}${paused}`);
		}
	}
	lines.push("");
	lines.push("spend:");
	if (report.spend.unavailable) {
		lines.push(`  ${report.spend.unavailable}`);
	} else {
		lines.push(
			report.spend.costUsd > 0 ? `  lifetime: ${formatUsd(report.spend.costUsd)}` : "  no recorded spend yet",
		);
	}
	return lines.join("\n");
}
