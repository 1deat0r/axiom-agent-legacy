import type { GatewayCommand, GatewayCommandContext } from "../types.js";
import { helpCommand } from "./help.js";
import { profilesCommand } from "./profiles.js";
import { projectsCommand } from "./projects.js";
import { searchCommand } from "./search.js";
import { sessionsCommand } from "./sessions.js";
import { soulCommand } from "./soul.js";

/** All gateway-local commands; they never reach the model. */
export const gatewayCommands: GatewayCommand[] = [
	helpCommand,
	searchCommand,
	sessionsCommand,
	profilesCommand,
	projectsCommand,
	soulCommand,
];

export function commandByName(name: string): GatewayCommand | undefined {
	return gatewayCommands.find((c) => c.name === name);
}

/** Dispatch a command message (text is "name arg1 arg2 ..."), return its reply. */
export function dispatchCommand(text: string, ctx: GatewayCommandContext): string {
	const trimmed = text.trim();
	const space = trimmed.search(/\s/);
	const raw = space < 0 ? trimmed : trimmed.slice(0, space);
	const name = raw.startsWith("/") ? raw.slice(1) : raw;
	const rest = space < 0 ? "" : trimmed.slice(space + 1).trim();
	const args = rest.length === 0 ? [] : rest.split(/\s+/);
	const command = commandByName(name);
	if (!command) return `unknown command '/${name}' — try /help`;
	return String(command.handler(args, ctx));
}
