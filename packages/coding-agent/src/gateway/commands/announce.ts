import type { GatewayCommand } from "../types.js";

/**
 * `/announce <text>` — fan one message out to every configured deliverTo
 * channel on the active transport (ADR-0022). The Gateway's deliverToAll is
 * invoked fire-and-forget (the fan-out is asynchronous) and returns a
 * confirmation immediately; every fan-out send is recorded in the delivery
 * ledger, so the operator can audit with `/ledger` after.
 */
export const announceCommand: GatewayCommand = {
	name: "announce",
	summary: "Send a message to every configured deliverTo channel",
	handler(args, ctx) {
		const text = args.join(" ").trim();
		if (text.length === 0) return "/announce <text> — nothing to send";
		if (!ctx.deliverToAll) return "fan-out is not wired for this gateway";
		void ctx.deliverToAll(text);
		return "announcing to every configured channel… (check /ledger)";
	},
};
