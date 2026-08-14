import type { GatewayCommand } from "../types.js";

/**
 * `/announce <text>` — fan one message out to every configured deliverTo
 * channel (ADR-0022/0023/0062). Named targets reach their transport; unnamed
 * targets reach every active transport, not just the channel's own. The
 * Gateway's deliverToAll is invoked fire-and-forget (the fan-out is
 * asynchronous) and returns a confirmation immediately; every fan-out send is
 * recorded in the delivery ledger, so the operator can audit with `/ledger`.
 */
export const announceCommand: GatewayCommand = {
	name: "announce",
	summary: "Send a message to every deliverTo channel (across all active transports)",
	handler(args, ctx) {
		const text = args.join(" ").trim();
		if (text.length === 0) return "/announce <text> — nothing to send";
		if (!ctx.deliverToAll) return "fan-out is not wired for this gateway";
		void ctx.deliverToAll(text);
		return "announcing to every configured channel… (check /ledger)";
	},
};
