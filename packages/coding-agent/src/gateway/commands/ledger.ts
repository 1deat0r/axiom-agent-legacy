import type { GatewayCommand } from "../types.js";

/** `/ledger [n]` — list the most recent n delivery-ledger entries (default 10). */
export const ledgerCommand: GatewayCommand = {
	name: "ledger",
	summary: "Show recent delivery ledger entries",
	handler(args, ctx) {
		if (!ctx.ledger) return "delivery ledger is not wired for this gateway";
		const parsed = Number(args[0]);
		const n = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
		const entries = ctx.ledger.recent(n);
		if (entries.length === 0) return "no deliveries recorded yet";
		return entries
			.map((e) => {
				const status = e.ok ? "ok" : `ERR ${e.error ?? "unknown"}`;
				const who = e.recipient.length > 0 ? ` (${e.recipient})` : "";
				return `${new Date(e.ts).toISOString()} ${e.transport} -> ${e.channel}${who} ${e.chars} chars [${status}]`;
			})
			.join("\n");
	},
};
