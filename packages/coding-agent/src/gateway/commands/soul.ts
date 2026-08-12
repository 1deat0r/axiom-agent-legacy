import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayCommand } from "../types.js";

/** A profile's SOUL.md path: the active profile under projectHome, else profiles/<name>. */
function soulPath(ctx: { projectHome: string; axiomHomeDir: string; profile: string }, name: string): string {
	if (name === ctx.profile) return join(ctx.projectHome, "SOUL.md");
	return join(ctx.axiomHomeDir, "profiles", name, "SOUL.md");
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
		const path = soulPath(ctx, name);
		if (text !== undefined) {
			writeFileSync(path, `${text.trim()}\n`, "utf8");
			return `SOUL.md for '${name}' updated`;
		}
		if (!existsSync(path)) return `no SOUL.md for '${name}' (create it with /soul ${name} <text>)`;
		return `SOUL.md for '${name}':\n${readFileSync(path, "utf8").trim()}`;
	},
};
