import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleProfileCommand } from "../src/cli/profile-command.js";

// Uses a real temp home with injected fs io, mirroring the projects-command test rig.
describe("profile command", () => {
	async function io(home?: string) {
		const dir = home ?? (await mkdtemp(join(tmpdir(), "axiom-profile-")));
		const out: string[] = [];
		const opts = {
			axiomHome: dir,
			writeText: async (path: string, text: string) => {
				await mkdir(dirname(path), { recursive: true });
				await (await import("node:fs/promises")).writeFile(path, text);
			},
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
			stdout: (s: string) => {
				out.push(s);
			},
		};
		return { dir, opts, out };
	}

	it("ignores non-profile commands", async () => {
		const { opts } = await io();
		expect(await handleProfileCommand(["chat", "hello"], opts)).toBe(false);
	});

	it("creates and lists profiles", async () => {
		const { dir, opts, out } = await io();
		try {
			await handleProfileCommand(["profile", "create", "alpha"], opts);
			expect(out.join(" ")).toContain("created");
			out.length = 0;
			await handleProfileCommand(["profile", "list"], opts);
			expect(out.join(" ")).toContain("alpha");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports no profiles yet on switch", async () => {
		const { opts, out } = await io();
		await handleProfileCommand(["profile", "switch", "alpha"], opts);
		expect(out.join(" ")).toContain("No profiles yet");
	});

	it("reports an unknown profile on switch", async () => {
		const { dir, opts, out } = await io();
		try {
			await mkdir(join(dir, "profiles", "alpha"), { recursive: true });
			await handleProfileCommand(["profile", "switch", "beta"], opts);
			expect(out.join(" ")).toContain("Unknown profile");
			expect(out.join(" ")).toContain("alpha");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("validates an existing profile and shows how to run as it", async () => {
		const { dir, opts, out } = await io();
		try {
			await mkdir(join(dir, "profiles", "alpha"), { recursive: true });
			await handleProfileCommand(["profile", "switch", "alpha"], opts);
			expect(out.join(" ")).toContain("validated profile 'alpha'");
			expect(out.join(" ")).toContain("axiom --profile alpha");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("resolves the base home and reports when already running as the profile", async () => {
		// Running from inside a profile home (`<base>/profiles/alpha`) should still
		// resolve the base home to list profiles, and detect the active label.
		const base = await mkdtemp(join(tmpdir(), "axiom-profile-"));
		const profileHome = join(base, "profiles", "alpha");
		try {
			await mkdir(profileHome, { recursive: true });
			const { opts, out } = await io(profileHome);
			await handleProfileCommand(["profile", "switch", "alpha"], opts);
			expect(out.join(" ")).toContain("already running as 'alpha'");
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});
