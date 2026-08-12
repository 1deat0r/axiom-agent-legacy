/**
 * Profile registry (port #8, ADR-0014).
 *
 * A profile is a separate home (the Hermes model): `~/.axiom/profiles/<name>/`
 * holds SOUL.md, agent state (sessions/skills/settings via the active agent dir)
 * and axiom state (ledger, memory via AXIOM_HOME). The default profile is
 * implicit — no `--profile` means the plain axiom home (`~/.axiom`), so
 * beginners never see the concept.
 *
 * Rule (from Hermes): never point two agent processes at one profile home.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Env var the CLI sets and the axiom extensions read for the active home. */
export const AXIOM_HOME_ENV = "AXIOM_HOME";

/** The active axiom home: AXIOM_HOME env, else `~/.axiom`. */
export function axiomHome(env: Record<string, string | undefined> = process.env): string {
	return env[AXIOM_HOME_ENV] ?? join(homedir(), ".axiom");
}

/** A named profile's home directory. */
export function profileDir(name: string, home: string = axiomHome()): string {
	return join(home, "profiles", name);
}

/** Profile names must be filesystem-safe and lowercase-dash. */
export function isValidProfileName(name: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

/** The profile's display label: the name when inside profiles/, else "default". */
export function profileLabel(home: string): string {
	const parent = home.split(/[/]/).filter(Boolean).at(-2);
	return parent === "profiles" ? (home.split(/[/]/).filter(Boolean).at(-1) ?? "default") : "default";
}

/** What booting under a profile means: its own axiom home + its own agent dir. */
export function resolveProfile(
	name: string | undefined,
	env: Record<string, string | undefined> = process.env,
): { axiomHome: string; agentDir: string | undefined } {
	if (name === undefined) return { axiomHome: axiomHome(env), agentDir: undefined };
	// The `default` profile is implicit (ADR-0014): it maps to the root axiom
	// home with no redirect, so `--profile default` behaves identically to no
	// flag. Redirecting it to ~/.axiom/profiles/default would split the shared
	// gateway config/offset away from the operator's ~/.axiom home.
	if (name === "default") return { axiomHome: axiomHome(env), agentDir: undefined };
	const home = profileDir(name, axiomHome(env));
	return { axiomHome: home, agentDir: home };
}
