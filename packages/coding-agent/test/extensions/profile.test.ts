import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { handleProfileCommand } from "../../src/cli/profile-command.js";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import { defaultLedgerDeps } from "../../src/extensions/ledger/index.js";
import { createMemoryExtension } from "../../src/extensions/memory/index.js";
import axiomProfileExtension, { createProfileExtension, soulBlock } from "../../src/extensions/profile/index.js";
import {
	AXIOM_HOME_ENV,
	axiomHome,
	isValidProfileName,
	profileDir,
	profileLabel,
	resolveProfile,
} from "../../src/extensions/profile/registry.js";

describe("profile registry", () => {
	it("defaults the axiom home to ~/.axiom", () => {
		const env: Record<string, string | undefined> = {};
		expect(axiomHome(env)).toBe(join(process.env.HOME ?? "/tmp", ".axiom"));
	});

	it("honors AXIOM_HOME", () => {
		const env = { [AXIOM_HOME_ENV]: "/custom/home" };
		expect(axiomHome(env)).toBe("/custom/home");
	});

	it("builds profile dirs under the axiom home", () => {
		const env = { [AXIOM_HOME_ENV]: "/custom/home" };
		expect(profileDir("coder", axiomHome(env))).toBe("/custom/home/profiles/coder");
	});

	it("accepts safe profile names", () => {
		expect(isValidProfileName("coder")).toBe(true);
		expect(isValidProfileName("my-agent-2")).toBe(true);
	});

	it("rejects unsafe profile names", () => {
		expect(isValidProfileName("")).toBe(false);
		expect(isValidProfileName("Coder")).toBe(false);
		expect(isValidProfileName("a b")).toBe(false);
		expect(isValidProfileName("a/b")).toBe(false);
		expect(isValidProfileName("..")).toBe(false);
	});

	it("resolves no profile to the default home without an agent dir", () => {
		const env = { [AXIOM_HOME_ENV]: "/custom/home" };
		expect(resolveProfile(undefined, env)).toEqual({ axiomHome: "/custom/home", agentDir: undefined });
	});

	it("defaults resolve against the real environment", () => {
		expect(axiomHome()).toBe(join(process.env.HOME ?? "/tmp", ".axiom"));
		expect(profileDir("coder")).toBe(join(process.env.HOME ?? "/tmp", ".axiom", "profiles", "coder"));
		expect(resolveProfile(undefined)).toEqual({
			axiomHome: join(process.env.HOME ?? "/tmp", ".axiom"),
			agentDir: undefined,
		});
		expect(resolveProfile("coder").agentDir).toBe(join(process.env.HOME ?? "/tmp", ".axiom", "profiles", "coder"));
	});

	it("resolves a named profile to its own home and agent dir", () => {
		const env = { [AXIOM_HOME_ENV]: "/custom/home" };
		expect(resolveProfile("coder", env)).toEqual({
			axiomHome: "/custom/home/profiles/coder",
			agentDir: "/custom/home/profiles/coder",
		});
	});

	it("resolves the implicit default profile to the root home (no redirect)", () => {
		const env = { [AXIOM_HOME_ENV]: "/custom/home" };
		expect(resolveProfile("default", env)).toEqual({ axiomHome: "/custom/home", agentDir: undefined });
	});
});

describe("soul block", () => {
	it("renders a delimited identity block", () => {
		const block = soulBlock("  I am a focused agent.  ");
		expect(block).toContain("<<<profile>>>");
		expect(block).toContain("I am a focused agent.");
		expect(block).toContain("<</profile>>>");
	});

	it("injects the profile SOUL.md into the system prompt", async () => {
		const events = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
		const pi = {
			on: (event: string, h: (e: unknown, c: unknown) => Promise<unknown>) => events.set(event, h),
		} as unknown as ExtensionAPI;
		createProfileExtension({
			axiomHomeDir: () => "/profiles/coder",
			readText: async (path) => (path.endsWith("SOUL.md") ? "I am coder." : null),
		})(pi);
		const result = (await events.get("before_agent_start")!(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			null,
		)) as { systemPrompt?: string };
		expect(result.systemPrompt).toContain("base");
		expect(result.systemPrompt).toContain("I am coder.");
	});

	it("sets the active-profile footer status at agent_start", async () => {
		const events = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
		const pi = {
			on: (event: string, h: (e: unknown, c: unknown) => Promise<unknown>) => events.set(event, h),
		} as unknown as ExtensionAPI;
		const statuses: Array<[string, string | undefined]> = [];
		createProfileExtension({
			axiomHomeDir: () => "/custom/home/profiles/client-alpha",
			readText: async () => null,
		})(pi);
		await events.get("agent_start")!(null, {
			ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) },
		});
		expect(statuses).toContainEqual(["axiom.profile", "client-alpha"]);
	});

	it("labels the default home as default", () => {
		expect(profileLabel("/home/u/.axiom")).toBe("default");
		expect(profileLabel("/home/u/.axiom/profiles/coder")).toBe("coder");
	});

	it("leaves the system prompt alone when SOUL.md is missing", async () => {
		const events = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
		const pi = {
			on: (event: string, h: (e: unknown, c: unknown) => Promise<unknown>) => events.set(event, h),
		} as unknown as ExtensionAPI;
		createProfileExtension({ axiomHomeDir: () => "/profiles/coder", readText: async () => null })(pi);
		const result = await events.get("before_agent_start")!(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			null,
		);
		expect(result).toBeUndefined();
	});
});

describe("handleProfileCommand", () => {
	async function io() {
		const dir = await mkdtemp(join(tmpdir(), "axiom-profiles-"));
		const written: string[] = [];
		const out: string[] = [];
		return {
			dir,
			opts: {
				axiomHome: dir,
				writeText: async (path: string, text: string) => {
					written.push(path);
					await import("node:fs/promises").then((fs) => fs.writeFile(path, text));
				},
				mkdirp: async (path: string) => {
					await import("node:fs/promises").then((fs) => fs.mkdir(path, { recursive: true }));
				},
				readdir: async (path: string) => {
					const fs = await import("node:fs/promises");
					try {
						return await fs.readdir(path);
					} catch {
						return [];
					}
				},
				stdout: (s: string) => {
					out.push(s);
				},
			},
			written,
			out,
		};
	}

	it("scaffolds a profile with a starter SOUL.md", async () => {
		const { dir, opts, written, out } = await io();
		try {
			const handled = await handleProfileCommand(["profile", "create", "coder"], opts);
			expect(handled).toBe(true);
			expect(written.some((p) => p.endsWith(join("profiles", "coder", "SOUL.md")))).toBe(true);
			expect(out.join(" ")).toContain("coder");
			expect(out.join(" ")).toMatch(/--profile coder/);
			expect(out.join(" ")).toMatch(/\/login/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses unsafe profile names", async () => {
		const { dir, opts, out } = await io();
		try {
			const handled = await handleProfileCommand(["profile", "create", "../evil"], opts);
			expect(handled).toBe(true);
			expect(out.join(" ")).toMatch(/invalid|name/i);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses to recreate an existing profile", async () => {
		const { dir, opts, out } = await io();
		try {
			await handleProfileCommand(["profile", "create", "coder"], opts);
			const handled = await handleProfileCommand(["profile", "create", "coder"], opts);
			expect(handled).toBe(true);
			expect(out.join(" ")).toMatch(/exists/i);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("lists profiles", async () => {
		const { dir, opts, out } = await io();
		try {
			await handleProfileCommand(["profile", "create", "coder"], opts);
			await handleProfileCommand(["profile", "list"], opts);
			expect(out.join(" ")).toContain("coder");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("ignores non-profile commands", async () => {
		const { opts } = await io();
		expect(await handleProfileCommand(["chat", "hello"], opts)).toBe(false);
	});

	it("lists no profiles yet when none exist", async () => {
		const { dir, opts, out } = await io();
		try {
			await handleProfileCommand(["profile", "list"], opts);
			expect(out.join(" ")).toContain("No profiles yet");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("prints usage for an unknown profile subcommand", async () => {
		const { dir, opts, out } = await io();
		try {
			const handled = await handleProfileCommand(["profile", "frobnicate"], opts);
			expect(handled).toBe(true);
			expect(out.join(" ")).toContain("Usage: profile create");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("profile extension defaults", () => {
	it("the default export registers the hook", () => {
		const events = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
		const pi = {
			on: (event: string, h: (e: unknown, c: unknown) => Promise<unknown>) => events.set(event, h),
		} as unknown as ExtensionAPI;
		axiomProfileExtension(pi);
		expect(events.has("before_agent_start")).toBe(true);
	});

	it("the default home resolves via AXIOM_HOME and tolerates a missing SOUL.md", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-soul-"));
		try {
			vi.stubEnv(AXIOM_HOME_ENV, dir);
			const events = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
			const pi = {
				on: (event: string, h: (e: unknown, c: unknown) => Promise<unknown>) => events.set(event, h),
			} as unknown as ExtensionAPI;
			createProfileExtension()(pi);
			const result = await events.get("before_agent_start")!(
				{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
				null,
			);
			expect(result).toBeUndefined();
		} finally {
			vi.unstubAllEnvs();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("a SOUL.md path that is not a file rejects", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-soul-"));
		try {
			const { mkdir } = await import("node:fs/promises");
			await mkdir(join(dir, "SOUL.md"));
			const events = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
			const pi = {
				on: (event: string, h: (e: unknown, c: unknown) => Promise<unknown>) => events.set(event, h),
			} as unknown as ExtensionAPI;
			createProfileExtension({ axiomHomeDir: () => dir })(pi);
			await expect(
				events.get("before_agent_start")!({ type: "before_agent_start", prompt: "hi", systemPrompt: "base" }, null),
			).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("the command uses real defaults when no io is injected", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-profiles-"));
		try {
			vi.stubEnv(AXIOM_HOME_ENV, dir);
			// list before anything exists exercises the missing-directory path.
			expect(await handleProfileCommand(["profile", "list"])).toBe(true);
			expect(await handleProfileCommand(["profile", "create", "coder"])).toBe(true);
			expect(await handleProfileCommand(["profile", "list"])).toBe(true);
			// The real-fs fallbacks ran: the profile home and SOUL.md exist.
			const { readFile } = await import("node:fs/promises");
			expect(await readFile(join(dir, "profiles", "coder", "SOUL.md"), "utf8")).toContain("I am coder");
		} finally {
			vi.unstubAllEnvs();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("--profile flag", () => {
	it("parses --profile <name>", () => {
		const parsed = parseArgs(["--profile", "coder", "-c"]);
		expect(parsed.profile).toBe("coder");
		expect(parsed.continue).toBe(true);
	});
});

describe("axiom extension paths follow the profile home", () => {
	it("the ledger config defaults into AXIOM_HOME", () => {
		vi.stubEnv(AXIOM_HOME_ENV, "/profiles/coder");
		try {
			expect(defaultLedgerDeps().overridesPath).toBe(join("/profiles/coder", "ledger.json"));
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("memory defaults into AXIOM_HOME", () => {
		const tools: Array<{ name: string }> = [];
		const pi = {
			registerTool: (t: { name: string }) => {
				tools.push(t);
			},
			on: () => {},
		} as unknown as ExtensionAPI;
		vi.stubEnv(AXIOM_HOME_ENV, "/profiles/coder");
		try {
			createMemoryExtension()(pi);
			expect(tools.some((t) => t.name === "memory")).toBe(true);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
