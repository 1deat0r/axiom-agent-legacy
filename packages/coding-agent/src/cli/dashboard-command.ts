/**
 * `axiom dashboard [--json]` — the CLI surface of the dashboard capability
 * (ADR-0085), the primary surface for the daily driver. Renders the same
 * shared aggregation module as the gateway /dashboard; --json prints the
 * structured report. Live marks come from the default daemon socket when it
 * is reachable (a short probe; the daemon's session list is the authoritative
 * "what is running now" set) and are simply absent otherwise.
 */
import { join } from "node:path";
import { getAgentDir, getCronJobsPath, getSessionsDir } from "../config.js";
import { buildDashboardReport, renderDashboardText } from "../core/dashboard.js";
import { DaemonClient } from "../modes/daemon/daemon-client.js";
import { defaultDaemonSocketPath } from "../modes/daemon/daemon-socket.js";

export interface DashboardCommandDeps {
	sessionsDir?: string;
	cronStorePath?: string;
	ledgerPath?: string;
	/** Resolves live session ids; the default probes the default daemon socket. */
	liveSessionIds?: () => ReadonlySet<string> | Promise<ReadonlySet<string>>;
	now?: Date;
	write?: (line: string) => void;
}

/** Probe the default daemon socket for the live session set (best effort). */
export async function probeDaemonLiveSessions(timeoutMs = 500): Promise<ReadonlySet<string>> {
	const ids = new Set<string>();
	const client = new DaemonClient(defaultDaemonSocketPath());
	try {
		await client.connect(timeoutMs);
		const response = await client.request({ type: "list" }, timeoutMs);
		if (!response || typeof response !== "object") return ids;
		if (!("success" in response) || !(response as { success?: boolean }).success) return ids;
		const data = (response as { data?: unknown }).data;
		const sessions = (data as { sessions?: unknown } | undefined)?.sessions;
		if (!Array.isArray(sessions)) return ids;
		for (const session of sessions) {
			if (typeof session !== "object" || session === null) continue;
			const candidate = session as { sessionId?: unknown; activeSessionId?: unknown; isSessionActive?: unknown };
			if (candidate.isSessionActive === false) continue;
			const id =
				typeof candidate.activeSessionId === "string"
					? candidate.activeSessionId
					: typeof candidate.sessionId === "string"
						? candidate.sessionId
						: undefined;
			if (id) ids.add(id);
		}
	} catch {
		// No daemon reachable: no live marks, the report still renders.
	} finally {
		client.close();
	}
	return ids;
}

export async function runDashboard(json: boolean, deps: DashboardCommandDeps = {}): Promise<void> {
	const agentDir = getAgentDir();
	let liveSessionIds: ReadonlySet<string>;
	try {
		liveSessionIds = deps.liveSessionIds ? await deps.liveSessionIds() : await probeDaemonLiveSessions();
	} catch {
		// No daemon reachable: no live marks, the report still renders.
		liveSessionIds = new Set();
	}
	const report = buildDashboardReport({
		sessionsDir: deps.sessionsDir ?? getSessionsDir(agentDir),
		cronStorePath: deps.cronStorePath ?? getCronJobsPath(agentDir),
		ledgerPath: deps.ledgerPath ?? join(agentDir, "ledger.json"),
		liveSessionIds,
	});
	const output = json ? JSON.stringify(report, null, 2) : renderDashboardText(report, deps.now);
	const write = deps.write ?? ((line: string) => console.log(line));
	write(output);
}
