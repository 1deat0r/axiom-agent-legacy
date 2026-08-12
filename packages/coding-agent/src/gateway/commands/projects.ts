/**
 * The gateway `/projects` command: a friendly menu of the active profile's
 * projects, live per-channel switching (`use`), and hardened add/remove.
 *
 * A project is a workspace under <projectHome>/projects. The CHAT's active
 * project is persisted per channel (ActiveProjectStore); agent messages on a
 * chat with an active project run anchored to it (projectRoot, project-scoped
 * session). `rm` clears the store mapping across channels, bumps the project's
 * generation (fresh sessions if the project is re-created), and asks the
 * gateway to drop the composite session mappings (dropProjectSessions).
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import type { GatewayCommand } from "../types.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The active profile's projects root (projectHome holds the profile home). */
function projectsRoot(projectHome: string): string {
	return join(projectHome, "projects");
}

/** Sorted project names under the projects root (missing root -> empty). */
export function listProjects(root: string): string[] {
	try {
		return readdirSync(root, { encoding: "utf8" })
			.filter((n) => !n.startsWith("."))
			.sort();
	} catch {
		return [];
	}
}

export const projectsCommand: GatewayCommand = {
	name: "projects",
	summary: "List projects, switch this chat's active project, or add/remove",
	handler(args, ctx) {
		const root = projectsRoot(ctx.projectHome);
		const sub = args[0];
		if (sub === "add") {
			const name = args[1];
			if (!name || !NAME_RE.test(name)) return "invalid project name (lowercase a-z0-9 and dashes)";
			mkdirSync(join(root, name), { recursive: true });
			return `project '${name}' added to profile '${ctx.profile}'`;
		}
		if (sub === "rm") {
			const name = args[1];
			if (!name || !NAME_RE.test(name)) return "invalid project name (lowercase a-z0-9 and dashes)";
			// Containment guard (defense in depth; NAME_RE already excludes
			// separators): the target must resolve INSIDE the projects root —
			// `rm ..` must never reach the profile home.
			const target = join(root, name);
			if (!target.startsWith(root + sep)) return "invalid project name";
			if (!existsSync(target)) return `no project '${name}'`;
			rmSync(target, { recursive: true, force: true });
			// Clear the active mapping on every channel and bump the generation
			// so a re-created project starts FRESH sessions, then drop the
			// composite session mappings (hygiene; the generation already makes
			// stale ids unreachable).
			ctx.activeProjects?.removeProject(name);
			ctx.dropProjectSessions?.(name);
			return `project '${name}' removed (its chat sessions reset)`;
		}
		if (sub === "use") {
			const name = args[1];
			if (!name || !NAME_RE.test(name)) return "invalid project name (lowercase a-z0-9 and dashes)";
			if (!existsSync(join(root, name))) {
				return `no project '${name}' — create it with /projects add ${name}`;
			}
			if (!ctx.channelId || !ctx.activeProjects) return "usage: /projects use <name> (from a chat)";
			ctx.activeProjects.set(ctx.channelId, name);
			return `this chat now runs anchored to project '${name}'`;
		}
		// Menu: the list with the active project marked, plus the actions.
		const existing = listProjects(root);
		const active = ctx.activeProject;
		const head =
			existing.length === 0
				? `no projects on profile '${ctx.profile}' yet`
				: `projects on '${ctx.profile}' — active: ${active ?? "none (chat runs unanchored)"}`;
		const rows = existing.map((n) => (n === active ? `  ${n}   (active)` : `  ${n}`)).join("\n");
		const actions = [
			"/projects use <name>   switch this chat to a project",
			"/projects add <name>   create a project",
			"/projects rm <name>    remove a project (resets its sessions)",
		].join("\n");
		return existing.length === 0 ? `${head}\n\n${actions}` : `${head}\n\n${rows}\n\n${actions}`;
	},
};
