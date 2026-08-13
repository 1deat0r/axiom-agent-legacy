import type { GatewayCommand, GatewayCommandContext } from "../types.js";

/**
 * /new — archive this channel's session so the next run starts fresh
 * (streaming v2 follow-up: a huge session makes every reply slow).
 */
export const newCommand: GatewayCommand = {
	name: "new",
	summary: "Start a fresh session for this channel (archives the old one)",
	handler(_args: string[], ctx: GatewayCommandContext): string {
		if (!ctx.resetSession) return "/new is not available on this gateway run";
		return ctx.resetSession();
	},
};
