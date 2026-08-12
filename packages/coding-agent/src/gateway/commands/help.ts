import type { GatewayCommand } from "../types.js";

export const helpCommand: GatewayCommand = {
	name: "help",
	summary: "Show gateway commands",
	handler() {
		return [
			"axiom gateway commands:",
			"  /help                 this help",
			"  /cron <add|list|rm>     schedule agent runs and deliver output here",
			"  /profiles             list profiles",
			"  /profiles create <n>  create a profile (SOUL.md scaffolded)",
			"  /profiles switch <n>  switch the active profile",
			"  /projects             list projects of the active profile",
			"  /projects add <n>     add a project",
			"  /projects rm <n>      remove a project",
			"  /soul [name]          view a profile's SOUL.md",
			"  /soul <name> <text>   set a profile's SOUL.md",
			"  /announce <text>       send a message to every deliverTo channel",
			"  /ledger [n]            show the last n delivery-ledger entries",
			"  /search <q>           search past sessions [--all] [--limit N] [--offset N]",
			"  /sessions             browse recent past sessions [--all] [--limit N]",
		].join("\n");
	},
};
