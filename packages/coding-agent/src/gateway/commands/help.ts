import type { GatewayCommand, GatewayCommandContext } from "../types.js";
import { describeActiveModel } from "./model.js";

export const helpCommand: GatewayCommand = {
	name: "help",
	summary: "Show gateway commands",
	handler(_args: string[], ctx: GatewayCommandContext): string {
		const status = ctx.modelStore ? describeActiveModel(ctx.modelStore, ctx.profile) : undefined;
		return [
			"axiom gateway commands:",
			...(status ? [status, ""] : []),
			"  /help                 this help",
			"  /update               check for updates (fetch + report)",
			"  /update now           update to latest main, rebuild, restart",
			"  /model                show the active model (hotswap, ADR-0033)",
			"  /model <provider> <model>   switch model without a restart",
			"  /model clear          revert to the profile's default model",
			"  /cron <add|list|rm>     schedule agent runs and deliver output here",
			"  /profiles             list profiles",
			"  /profiles create <n>  create a profile (SOUL.md scaffolded)",
			"  /profiles switch <n>  switch the active profile",
			"  /projects             project menu (active project marked)",
			"  /projects use <n>     switch this chat to a project",
			"  /projects add <n>     add a project",
			"  /projects rm <n>      remove a project",
			"  /soul [name]          view a profile's SOUL.md",
			"  /soul <name> <text>   set a profile's SOUL.md",
			"  /announce <text>       send a message to every deliverTo channel (all active transports)",
			"  /ledger [n]            show the last n delivery-ledger entries",
			"  /search <q>           search past sessions [--all] [--limit N] [--offset N]",
			"  /sessions             browse recent past sessions [--all] [--limit N]",
			"  /new                  start a fresh session (archives the old one)",
		].join("\n");
	},
};
