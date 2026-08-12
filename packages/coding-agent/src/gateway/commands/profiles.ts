import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listProfiles, profileSoulPath, profilesRoot, projectDir } from "../registry.js";
import type { GatewayCommand } from "../types.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export const profilesCommand: GatewayCommand = {
	name: "profiles",
	summary: "List, create, or switch profiles",
	handler(args, ctx) {
		const sub = args[0];
		if (sub === "create") {
			const name = args[1];
			if (!name || !NAME_RE.test(name)) return "invalid profile name (lowercase a-z0-9 and dashes)";
			return createProfile(ctx.axiomHomeDir, name);
		}
		if (sub === "switch") {
			const name = args[1];
			const existing = listProfiles(ctx.axiomHomeDir);
			if (!name || !existing.includes(name)) {
				return existing.length === 0
					? "no profiles yet — create one with /profiles create <name>"
					: `unknown profile '${name}' — existing: ${existing.join(", ")}`;
			}
			return `switched to profile '${name}' (its SOUL.md rides on future completions)`;
		}
		const existing = listProfiles(ctx.axiomHomeDir);
		return existing.length === 0 ? "no profiles yet" : `profiles: ${existing.join(", ")}`;
	},
};

/** Scaffold a profile home + projects dir; return a status line. */
export function createProfile(axiomHomeDir: string, name: string): string {
	const home = join(profilesRoot(axiomHomeDir), name);
	mkdirSync(home, { recursive: true });
	mkdirSync(projectDir(home, ""), { recursive: true });
	const soulPath = profileSoulPath(axiomHomeDir, name);
	if (!existsSync(soulPath)) {
		writeFileSync(
			soulPath,
			`# SOUL.md — ${name}\n\nI am ${name}, a focused Axiom agent with my own identity, memory, and state.\n`,
			"utf8",
		);
	}
	return `profile '${name}' created with a starter SOUL.md`;
}
