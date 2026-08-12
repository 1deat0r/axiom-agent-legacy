import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleProjectsCommand, listProjectNames } from "../src/cli/projects-command.js";

// Uses a real temp home with injected fs io, mirroring the profile-command test rig.
describe("projects command", () => {
	async function io() {
		const dir = await mkdtemp(join(tmpdir(), "axiom-projects-"));
		const out: string[] = [];
		const opts = {
			axiomHome: dir,
			mkdirp: async (path: string) => {
				await mkdir(path, { recursive: true });
			},
			readdir: async (path: string) => {
				try {
					return await readdir(path);
				} catch {
					return [];
				}
			},
			exists: (path: string) => existsSync(path),
			rm: async (path: string) => {
				await rm(path, { recursive: true, force: true });
			},
			stdout: (s: string) => {
				out.push(s);
			},
		};
		return { dir, opts, out };
	}

	it("ignores non-projects commands", async () => {
		const { opts } = await io();
		expect(await handleProjectsCommand(["chat", "hello"], opts)).toBe(false);
	});

	it("lists no projects yet when none exist", async () => {
		const { opts, out } = await io();
		await handleProjectsCommand(["projects"], opts);
		expect(out.join(" ")).toContain("no projects");
	});

	it("adds, lists, and removes projects on the active profile", async () => {
		const { dir, opts, out } = await io();
		try {
			await handleProjectsCommand(["projects", "add", "alpha"], opts);
			expect(out.join(" ")).toContain("added");
			await handleProjectsCommand(["projects"], opts);
			expect(out.join(" ")).toContain("alpha");
			await handleProjectsCommand(["projects", "rm", "alpha"], opts);
			expect(out.join(" ")).toContain("removed");
			out.length = 0;
			await handleProjectsCommand(["projects"], opts);
			expect(out.join(" ")).toContain("no projects");
			expect(await readdir(join(dir, "projects"))).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses unsafe project names", async () => {
		const { opts, out } = await io();
		await handleProjectsCommand(["projects", "add", "../evil"], opts);
		expect(out.join(" ")).toMatch(/Usage/);
	});

	it("reports a missing project on rm", async () => {
		const { opts, out } = await io();
		await handleProjectsCommand(["projects", "rm", "nope"], opts);
		expect(out.join(" ")).toContain("no project");
	});

	it("lists project names for completion", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-projects-"));
		try {
			await mkdir(join(dir, "projects", "alpha"), { recursive: true });
			await mkdir(join(dir, "projects", "beta"), { recursive: true });
			expect(await listProjectNames(dir)).toEqual(["alpha", "beta"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("runs against the real axiom home when no io is injected", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-projects-"));
		const prev = process.env.AXIOM_HOME;
		process.env.AXIOM_HOME = dir;
		try {
			expect(await handleProjectsCommand(["projects", "add", "coder"])).toBe(true);
			const names = await readdir(join(dir, "projects"));
			expect(names).toContain("coder");
		} finally {
			if (prev === undefined) delete process.env.AXIOM_HOME;
			else process.env.AXIOM_HOME = prev;
			await rm(dir, { recursive: true, force: true });
		}
	});
});
