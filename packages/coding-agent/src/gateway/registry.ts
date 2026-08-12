/**
 * Minimal on-disk registries the project-manager commands operate on, under
 * the profile home: profiles (separate homes under <AXIOM_HOME>/profiles,
 * each with a SOUL.md) and, inside a profile, named projects (work dirs).
 * readdir/write injected for tests.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RegistryIO {
	readdir?(path: string): string[];
	exists?(path: string): boolean;
	readFile?(path: string): string;
	writeFile?(path: string, text: string): void;
	mkdirp?(path: string): void;
	rm?(path: string): void;
}

export function registryIO(): RegistryIO {
	return {
		readdir: (p) => readdirSync(p, { encoding: "utf8" }),
		exists: (p) => existsSync(p),
		readFile: (p) => readFileSync(p, "utf8"),
		writeFile: (p, t) => writeFileSync(p, t, "utf8"),
		mkdirp: (p) => mkdirSync(p, { recursive: true }),
		rm: (p) => rmSync(p, { recursive: true, force: true }),
	};
}

export function profilesRoot(axiomHomeDir: string): string {
	return join(axiomHomeDir, "profiles");
}

export function listProfiles(axiomHomeDir: string, io: RegistryIO = registryIO()): string[] {
	try {
		return (io.readdir?.(profilesRoot(axiomHomeDir)) ?? []).filter((n) => !n.startsWith("."));
	} catch {
		return [];
	}
}

export function profileSoulPath(axiomHomeDir: string, name: string): string {
	return join(profilesRoot(axiomHomeDir), name, "SOUL.md");
}

/** A named project's directory inside a profile. */
export function projectDir(axiomHomeDir: string, project: string): string {
	return join(axiomHomeDir, "projects", project);
}
