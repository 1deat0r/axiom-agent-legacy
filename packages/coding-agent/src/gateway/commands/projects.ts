import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GatewayCommand } from "../types.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The active profile's projects root. */
function projectsRoot(activeProfileHome: string): string {
	return join(activeProfileHome, "projects");
}

export const projectsCommand: GatewayCommand = {
	name: "projects",
	summary: "List, add, or remove projects of the active profile",
	handler(args, ctx) {
		const activeHome = join(ctx.axiomHomeDir, "profiles", ctx.profile);
		const root = projectsRoot(activeHome);
		const sub = args[0];
		if (sub === "add") {
			const name = args[1];
			if (!name || !NAME_RE.test(name)) return "invalid project name (lowercase a-z0-9 and dashes)";
			mkdirSync(join(root, name), { recursive: true });
			return `project '${name}' added to profile '${ctx.profile}'`;
		}
		if (sub === "rm") {
			const name = args[1];
			if (!name) return "usage: /projects rm <name>";
			const target = join(root, name);
			if (!existsSync(target)) return `no project '${name}'`;
			rmSync(target, { recursive: true, force: true });
			return `project '${name}' removed`;
		}
		let existing: string[] = [];
		try {
			existing = readdirSync(root, { encoding: "utf8" }).filter((n) => !n.startsWith("."));
		} catch {
			/* no projects root yet */
		}
		return existing.length === 0
			? `no projects on profile '${ctx.profile}' yet`
			: `projects on '${ctx.profile}': ${existing.join(", ")} (under ${root})`;
	},
};
