/**
 * `axiom projects` — the CLI sibling of the gateway's `/projects` command
 * (ADR-0014). Operates on the ACTIVE profile's projects root, exactly as the
 * gateway does: a named profile binds its home (AXIOM_HOME), and projects are
 * named work dirs inside that home. The implicit `default` profile uses the
 * root axiom home, so beginners never see the concept.
 *
 * Returns true when the invocation was a projects command.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { axiomHome } from "../extensions/profile/registry.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface ProjectsCommandIO {
	axiomHome?: string;
	mkdirp?(path: string): Promise<void>;
	readdir?(path: string): Promise<string[]>;
	exists?(path: string): boolean;
	rm?(path: string): void;
	stdout?(text: string): void;
}

export function handleProjectsCommand(args: string[], io: ProjectsCommandIO = {}): Promise<boolean> {
	if (args[0] !== "projects") return Promise.resolve(false);
	return runProjectsCommand(args, io);
}

async function runProjectsCommand(args: string[], io: ProjectsCommandIO): Promise<boolean> {
	const home = io.axiomHome ?? axiomHome();
	const root = join(home, "projects");
	const mkdirp = io.mkdirp ?? (async (p: string) => mkdirSync(p, { recursive: true }));
	const readdir = io.readdir ?? (async (p: string) => readdirSync(p, { encoding: "utf8" }));
	const exists = io.exists ?? ((p: string) => existsSync(p));
	const rm = io.rm ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
	const out = io.stdout ?? ((text: string) => console.log(text));

	const sub = args[1];
	if (sub === "add") {
		const name = args[2] ?? "";
		if (!NAME_RE.test(name)) {
			out("Usage: axiom projects add <name>  (lowercase letters, digits and dashes)");
			return true;
		}
		await mkdirp(join(root, name));
		out(`project '${name}' added to the active profile (${root})`);
		return true;
	}
	if (sub === "rm") {
		const name = args[2] ?? "";
		if (!name) {
			out("Usage: axiom projects rm <name>");
			return true;
		}
		const target = join(root, name);
		if (!exists(target)) {
			out(`no project '${name}'`);
			return true;
		}
		await rm(target);
		out(`project '${name}' removed`);
		return true;
	}

	let existing: string[] = [];
	try {
		existing = (await readdir(root)).filter((n) => !n.startsWith("."));
	} catch {
		// no projects root yet
	}
	out(
		existing.length === 0
			? "no projects on the active profile yet"
			: `projects: ${existing.join(", ")} (under ${root})`,
	);
	return true;
}

/** Existing project names under a project root (for completion & tests). */
export async function listProjectNames(home: string): Promise<string[]> {
	try {
		return readdirSync(join(home, "projects"))
			.filter((n) => !n.startsWith("."))
			.sort();
	} catch {
		return [];
	}
}
