/**
 * `axiom profile create|list|switch` — the profile scaffolding command (port
 * #8, ADR-0014 on the pi baseline), the CLI sibling of the gateway's
 * `/profiles` command.
 *
 * `profile create <name>` scaffolds `<axiom-home>/profiles/<name>/` with a
 * starter SOUL.md (the profile's identity). `profile list` shows existing
 * profiles. `profile switch <name>` validates a profile and tells the caller
 * how to run under it (a terminal run is `axiom --profile <name>`, not a
 * persistent boot). Returns true when the invocation was a profile command.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { axiomHome, isValidProfileName, profileDir, profileLabel } from "../extensions/profile/registry.js";

export interface ProfileCommandIO {
	axiomHome?: string;
	writeText?(path: string, text: string): Promise<void>;
	mkdirp?(path: string): Promise<void>;
	readdir?(path: string): Promise<string[]>;
	stdout?(text: string): void;
}

function starterSoul(name: string): string {
	return (
		`# SOUL.md — the creed of this profile\n\n` +
		`I am ${name}, a focused Axiom agent with my own identity, memory, and state.\n\n` +
		`Edit this file to give me my personality and priorities. It rides my system\n` +
		`prompt on every run.\n`
	);
}

/**
 * The base axiom home where profiles live (`<base>/profiles/<name>`). When the
 * active home is itself a profile home (`<base>/profiles/<name>`), a profile
 * command must list/validate against the base, not the nested profile home —
 * mirroring the gateway, which reads the base AXIOM_HOME for /profiles.
 */
function baseHome(home: string): string {
	const parent = dirname(home);
	return basename(parent) === "profiles" ? dirname(parent) : home;
}

/** Sorted profile names under the base home (mirror of listProjectNames). */
export async function listProfileNames(home: string): Promise<string[]> {
	const profilesDir = join(home, "profiles");
	try {
		return (await readdir(profilesDir)).filter((n) => isValidProfileName(n)).sort();
	} catch {
		return [];
	}
}

export async function handleProfileCommand(args: string[], io: ProfileCommandIO = {}): Promise<boolean> {
	if (args[0] !== "profile") return false;
	let home = io.axiomHome;
	if (home === undefined) home = axiomHome();
	let out: ((s: string) => void) | undefined = io.stdout;
	if (out === undefined) out = (s: string) => console.log(s);
	let write: ((path: string, text: string) => Promise<void>) | undefined = io.writeText;
	if (write === undefined) write = (p, t) => writeFile(p, t);
	let mkdirp: ((path: string) => Promise<void>) | undefined = io.mkdirp;
	if (mkdirp === undefined)
		mkdirp = async (p) => {
			await mkdir(p, { recursive: true });
		};
	let list: ((path: string) => Promise<string[]>) | undefined = io.readdir;
	if (list === undefined) list = (p) => readdir(p);

	const sub = args[1];
	if (sub === "create") {
		const name = args[2] ?? "";
		if (!isValidProfileName(name)) {
			out(`Error: invalid profile name '${name}' (use lowercase letters, digits and dashes)`);
			return true;
		}
		const dir = profileDir(name, home);
		const soulPath = join(dir, "SOUL.md");
		let exists = true;
		try {
			await readFile(soulPath);
		} catch {
			exists = false;
		}
		if (exists) {
			out(`Error: profile '${name}' already exists at ${dir}`);
			return true;
		}
		await mkdirp(dir);
		await write(soulPath, starterSoul(name));
		out(
			`Profile '${name}' created at ${dir} — edit SOUL.md to shape its identity.\n` +
				`Next: run '--profile ${name}', then /login to connect a provider (fresh profiles have no keys).`,
		);
		return true;
	}
	if (sub === "list") {
		const profilesDir = join(home, "profiles");
		let names: string[] = [];
		try {
			names = (await list(profilesDir)).filter((n) => isValidProfileName(n)).sort();
		} catch {
			names = [];
		}
		if (names.length === 0) {
			out("No profiles yet — create one with 'profile create <name>'.");
		} else {
			for (const name of names) out(name);
		}
		return true;
	}
	if (sub === "switch") {
		const name = args[2] ?? "";
		const base = baseHome(home);
		const profilesDir = join(base, "profiles");
		let names: string[] = [];
		try {
			names = (await list(profilesDir)).filter((n) => isValidProfileName(n)).sort();
		} catch {
			names = [];
		}
		if (!name || !names.includes(name)) {
			out(
				names.length === 0
					? "No profiles yet — create one with 'profile create <name>'."
					: `Unknown profile '${name}' — existing: ${names.join(", ")}`,
			);
			return true;
		}
		if (profileLabel(home) === name) {
			out(`already running as '${name}'`);
			return true;
		}
		out(
			`validated profile '${name}' — run 'axiom --profile ${name}' to operate as it ` +
				`(this session stays '${profileLabel(home)}')`,
		);
		return true;
	}
	out(
		"Usage: profile create <name>   scaffold a new profile (own home + SOUL.md)\n" +
			"       profile list           list existing profiles\n" +
			"       profile switch <name>  validate a profile; run 'axiom --profile <name>' as it",
	);
	return true;
}
