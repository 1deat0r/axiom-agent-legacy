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

import { spawnSync } from "node:child_process";
import { accessSync, constants, readlinkSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { axiomHome, isValidProfileName, profileDir, profileLabel } from "../extensions/profile/registry.js";

export interface ProfileCommandIO {
	axiomHome?: string;
	writeText?(path: string, text: string): Promise<void>;
	mkdirp?(path: string): Promise<void>;
	readdir?(path: string): Promise<string[]>;
	stdout?(text: string): void;
	/** Blocking editor runner (default: $EDITOR via spawnSync). */
	runEdit?(file: string, editor: EditorCommand): Promise<EditorRunResult>;
	/** Environment for $EDITOR/$VISUAL resolution (default: process.env). */
	env?: { EDITOR?: string; VISUAL?: string };
}

export type ProfileEditKind = "soul" | "settings";

export interface EditorCommand {
	cmd: string;
	args: string[];
}

/** The result of one blocking editor run, classified honestly. */
export interface EditorRunResult {
	/** Exit status, or null when the editor did not exit normally. */
	status: number | null;
	/** Spawn-failure message (e.g. "spawnSync vi ENOENT") when the editor never started. */
	error?: string;
	/** Termination signal when the editor was killed by a signal. */
	signal?: string | null;
}

/** Injectable probes for the editor fallback (deterministic in tests). */
export interface EditorResolutionDeps {
	/** Probe PATH for an executable and return its path, or undefined. */
	findExecutable?(name: string): string | undefined;
	/** Return the platform default editor path (Debian alternatives), or undefined. */
	alternativesEditor?(): string | undefined;
}

/** Well-known fallback editors, tried in order. */
const EDITOR_FALLBACK_NAMES = ["vi", "vim", "nano"] as const;
const ALTERNATIVES_EDITOR_PATH = "/etc/alternatives/editor";

/** Search PATH for an executable and return its full path, or undefined. */
function findExecutableOnPath(name: string): string | undefined {
	const pathValue = process.env.PATH ?? "";
	for (const dir of pathValue.split(delimiter)) {
		if (dir.length === 0) continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not here; keep looking.
		}
	}
	return undefined;
}

/** Resolve the Debian alternatives editor when it is a usable executable. */
function debianAlternativesEditor(): string | undefined {
	try {
		const target = readlinkSync(ALTERNATIVES_EDITOR_PATH);
		const candidate = target.startsWith("/") ? target : join(dirname(ALTERNATIVES_EDITOR_PATH), target);
		accessSync(candidate, constants.X_OK);
		return candidate;
	} catch {
		return undefined;
	}
}

/**
 * Split EDITOR/VISUAL into a command plus args ("code --wait" -> code + [--wait]).
 * When neither is set, resolve the platform default editor: the Debian
 * alternatives editor when usable, then the first available of vi/vim/nano.
 * "vi" remains the last resort so a missing editor surfaces as a clear spawn
 * error instead of a false success.
 */
export function resolveEditorCommand(
	env: { EDITOR?: string; VISUAL?: string } = {},
	deps: EditorResolutionDeps = {},
): EditorCommand {
	const raw = (env.EDITOR ?? env.VISUAL ?? "").trim();
	if (raw.length > 0) {
		const parts = raw.split(/\s+/).filter((part) => part.length > 0);
		const cmd = parts[0]!.replace(/^['"]|['"]$/g, "");
		return { cmd, args: parts.slice(1).map((part) => part.replace(/^['"]|['"]$/g, "")) };
	}
	const alternatives = (deps.alternativesEditor ?? debianAlternativesEditor)();
	if (alternatives) {
		return { cmd: alternatives, args: [] };
	}
	const find = deps.findExecutable ?? findExecutableOnPath;
	for (const name of EDITOR_FALLBACK_NAMES) {
		const found = find(name);
		if (found) {
			return { cmd: found, args: [] };
		}
	}
	return { cmd: "vi", args: [] };
}

/**
 * Run the editor as a BLOCKING child with inherited stdio and classify the
 * outcome honestly: a spawn failure (missing binary) and a signal termination
 * are both reported as failures, never as a successful edit.
 */
export function runEditorSync(file: string, editor: EditorCommand): EditorRunResult {
	let result: ReturnType<typeof spawnSync>;
	try {
		result = spawnSync(editor.cmd, [...editor.args, file], { stdio: "inherit" });
	} catch (error) {
		return { status: null, error: error instanceof Error ? error.message : String(error) };
	}
	return { status: result.status, signal: result.signal, error: result.error?.message };
}

/** Format an editor outcome as the one-line result both the CLI and the TUI print. */
export function formatEditorOutcome(
	name: string,
	kind: ProfileEditKind,
	file: string,
	editor: EditorCommand,
	result: EditorRunResult,
): string {
	if (result.error) {
		return `could not start editor '${editor.cmd}' — ${result.error} (set EDITOR to a usable editor, e.g. 'export EDITOR=vim')`;
	}
	if (result.signal) {
		return `editor '${editor.cmd}' was terminated by ${result.signal}`;
	}
	if (result.status === 0) {
		return `edited '${name}' ${kind === "soul" ? "SOUL.md" : "settings.json"} (${file})`;
	}
	if (result.status === null) {
		return `editor '${editor.cmd}' did not run`;
	}
	return `editor exited with status ${result.status}`;
}

/** Parse a "/profiles edit <name> [--settings]" argument string. */
export function parseProfileEditArgs(args: string): { name: string; kind: ProfileEditKind } | undefined {
	const parts = args
		.trim()
		.split(/\s+/)
		.filter((part) => part.length > 0);
	if (parts[0] !== "edit" || !parts[1]) {
		return undefined;
	}
	return { name: parts[1]!, kind: parts.includes("--settings") ? "settings" : "soul" };
}

/** Resolve the file a profile edit opens, against the base profile home. */
export function resolveProfileEditTarget(home: string, name: string, kind: ProfileEditKind): { file: string } {
	const base = profileBaseHome(home);
	return { file: join(profileDir(name, base), kind === "soul" ? "SOUL.md" : "settings.json") };
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
export function profileBaseHome(home: string): string {
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
	if (sub === "edit") {
		const name = args[2] ?? "";
		const kind: ProfileEditKind = args.includes("--settings") ? "settings" : "soul";
		const base = profileBaseHome(home);
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
		const target = resolveProfileEditTarget(base, name, kind);
		const editor = resolveEditorCommand(io.env);
		const runEdit = io.runEdit ?? (async (file, command) => runEditorSync(file, command));
		out(formatEditorOutcome(name, kind, target.file, editor, await runEdit(target.file, editor)));
		return true;
	}
	if (sub === "switch") {
		const name = args[2] ?? "";
		const base = profileBaseHome(home);
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
		"Usage: profile create <name>          scaffold a new profile (own home + SOUL.md)\n" +
			"       profile list                  list existing profiles\n" +
			"       profile switch <name>         validate a profile; run 'axiom --profile <name>' as it\n" +
			"       profile edit <name> [--settings]  open SOUL.md (or settings.json) in $EDITOR",
	);
	return true;
}
