/**
 * /dashboard — the gateway surface of the dashboard capability (ADR-0085):
 * a one-glance, whole-profile report (sessions, automation spine, spend)
 * rendered as plain text, built by the shared core aggregation module.
 * Read-only and global: no project anchoring, no writes.
 */
import { join } from "node:path";
import { getCronJobsPath } from "../../config.js";
import { buildDashboardReport, renderDashboardText } from "../../core/dashboard.js";
import type { GatewayCommand, GatewayCommandContext } from "../types.js";

/** The gateway's view of the shared home: the same stores the CLI reads. */
function buildGatewayDashboard(ctx: GatewayCommandContext): string {
	const report = buildDashboardReport({
		sessionsDir: ctx.sessionsDir,
		cronStorePath: getCronJobsPath(ctx.projectHome),
		ledgerPath: join(ctx.axiomHomeDir, "ledger.json"),
		liveSessionIds: ctx.liveSessionIds,
	});
	return renderDashboardText(report);
}

export const dashboardCommand: GatewayCommand = {
	name: "dashboard",
	summary: "One-glance report: sessions, automation spine, spend",
	handler(args, ctx) {
		if (args.length > 0) return "usage: /dashboard";
		try {
			return buildGatewayDashboard(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return `could not read dashboard: ${message}`;
		}
	},
};
