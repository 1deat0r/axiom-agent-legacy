import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayCommand } from "../types.js";

function soulPath(axiomHomeDir: string, profile: string): string {
	return join(axiomHomeDir, "profiles", profile, "SOUL.md");
}

export const soulCommand: GatewayCommand = {
	name: "soul",
	summary: "View or set a profile's SOUL.md",
	handler(args, ctx) {
		// /soul [name] view | /soul <name> <text> set
		let name = ctx.profile;
		let text: string | undefined;
		if (args.length >= 2) {
			name = args[0]!;
			text = args.slice(1).join(" ");
		} else if (args.length === 1) {
			name = args[0]!;
		}
		const path = soulPath(ctx.axiomHomeDir, name);
		if (text !== undefined) {
			writeFileSync(path, `${text.trim()}\n`, "utf8");
			return `SOUL.md for '${name}' updated`;
		}
		if (!existsSync(path)) return `no SOUL.md for '${name}' (create it with /soul ${name} <text>)`;
		return `SOUL.md for '${name}':\n${readFileSync(path, "utf8").trim()}`;
	},
};
