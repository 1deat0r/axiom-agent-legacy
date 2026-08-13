import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	formatEditorOutcome,
	handleProfileCommand,
	resolveEditorCommand,
	resolveProfileEditTarget,
	runEditorSync,
} from "../src/cli/profile-command.js";

// Uses a real temp home with injected fs io, mirroring the projects-command test rig.
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

/** Resolution deps with every probe disabled: no alternatives editor, nothing on PATH. */
function noProbes(): { alternativesEditor(): undefined; findExecutable(): undefined } {
	return { alternativesEditor: () => undefined, findExecutable: () => undefined };
}

describe("profile command", () => {
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

describe("profile edit", () => {
	it("resolves the SOUL.md edit target for a profile under the base home", () => {
		const target = resolveProfileEditTarget("/home/base", "alpha", "soul");
		expect(target.file).toBe(join("/home/base", "profiles", "alpha", "SOUL.md"));
	});

	it("resolves the settings.json edit target with kind settings", () => {
		const target = resolveProfileEditTarget("/home/base", "alpha", "settings");
		expect(target.file).toBe(join("/home/base", "profiles", "alpha", "settings.json"));
	});

	it("resolves targets against the base home even from a nested profile home", () => {
		const target = resolveProfileEditTarget("/home/base/profiles/beta", "alpha", "soul");
		expect(target.file).toBe(join("/home/base", "profiles", "alpha", "SOUL.md"));
	});

	it("parses EDITOR with arguments", () => {
		expect(resolveEditorCommand({ EDITOR: "code --wait" }, noProbes())).toEqual({ cmd: "code", args: ["--wait"] });
	});

	it("prefers the platform alternatives editor when EDITOR is unset", () => {
		const resolved = resolveEditorCommand(
			{},
			{
				alternativesEditor: () => "/usr/bin/vim.basic",
				findExecutable: () => "/usr/bin/vim",
			},
		);
		expect(resolved).toEqual({ cmd: "/usr/bin/vim.basic", args: [] });
	});

	it("falls back to the first available editor on PATH when EDITOR is unset", () => {
		const resolved = resolveEditorCommand(
			{ EDITOR: "" },
			{
				alternativesEditor: () => undefined,
				findExecutable: (name) => (name === "vim" ? "/usr/bin/vim" : undefined),
			},
		);
		expect(resolved).toEqual({ cmd: "/usr/bin/vim", args: [] });
	});

	it("keeps vi as the last-resort editor when nothing else resolves", () => {
		const resolved = resolveEditorCommand({}, noProbes());
		expect(resolved).toEqual({ cmd: "vi", args: [] });
	});

	it("runs the injected editor against an existing profile's SOUL.md", async () => {
		const { dir, opts, out } = await io();
		const edits: string[] = [];
		try {
			await handleProfileCommand(["profile", "create", "alpha"], opts);
			out.length = 0;
			const handled = await handleProfileCommand(["profile", "edit", "alpha"], {
				...opts,
				runEdit: async (file) => {
					edits.push(file);
					return { status: 0 };
				},
			});
			expect(handled).toBe(true);
			expect(edits).toEqual([join(dir, "profiles", "alpha", "SOUL.md")]);
			expect(out.join(" ")).toContain("edited");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("edits settings.json with the --settings flag", async () => {
		const { dir, opts } = await io();
		const edits: string[] = [];
		try {
			await handleProfileCommand(["profile", "create", "alpha"], opts);
			await handleProfileCommand(["profile", "edit", "alpha", "--settings"], {
				...opts,
				runEdit: async (file) => {
					edits.push(file);
					return { status: 0 };
				},
			});
			expect(edits).toEqual([join(dir, "profiles", "alpha", "settings.json")]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects an unknown profile on edit", async () => {
		const { dir, opts, out } = await io();
		try {
			await handleProfileCommand(["profile", "create", "alpha"], opts);
			out.length = 0;
			const handled = await handleProfileCommand(["profile", "edit", "ghost"], {
				...opts,
				runEdit: async () => ({ status: 0 }),
			});
			expect(handled).toBe(true);
			expect(out.join(" ")).toContain("Unknown profile 'ghost'");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports a spawn failure instead of claiming the edit succeeded", async () => {
		const { dir, opts, out } = await io();
		try {
			await handleProfileCommand(["profile", "create", "alpha"], opts);
			out.length = 0;
			await handleProfileCommand(["profile", "edit", "alpha"], {
				...opts,
				runEdit: async () => ({ status: null, error: "spawnSync vi ENOENT" }),
			});
			expect(out.join(" ")).toContain("could not start editor");
			expect(out.join(" ")).not.toContain("edited");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports a signal-terminated editor instead of success", async () => {
		const { dir, opts, out } = await io();
		try {
			await handleProfileCommand(["profile", "create", "alpha"], opts);
			out.length = 0;
			await handleProfileCommand(["profile", "edit", "alpha"], {
				...opts,
				runEdit: async () => ({ status: null, signal: "SIGTERM" }),
			});
			expect(out.join(" ")).toContain("terminated by SIGTERM");
			expect(out.join(" ")).not.toContain("edited");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("lists edit in the usage text", async () => {
		const { opts, out } = await io();
		await handleProfileCommand(["profile"], opts);
		expect(out.join(" ")).toContain("profile edit");
	});
});

describe("runEditorSync", () => {
	it("reports the spawn error when the editor binary is missing", () => {
		const result = runEditorSync("/tmp/somewhere/SOUL.md", { cmd: "axiom-no-such-editor-xyz", args: [] });
		expect(result.status).toBeNull();
		expect(result.error).toContain("ENOENT");
	});

	it("returns the editor's exit status", () => {
		const result = runEditorSync("/tmp/somewhere/SOUL.md", { cmd: "/bin/sh", args: ["-c", "exit 3"] });
		expect(result.status).toBe(3);
		expect(result.signal).toBeNull();
		expect(result.error).toBeUndefined();
	});

	it("reports the signal when the editor is killed", () => {
		const result = runEditorSync("/tmp/somewhere/SOUL.md", { cmd: "/bin/sh", args: ["-c", "kill -TERM $$"] });
		expect(result.status).toBeNull();
		expect(result.signal).toBe("SIGTERM");
	});

	it("reports success on a clean exit", () => {
		const result = runEditorSync("/tmp/somewhere/SOUL.md", { cmd: "/bin/true", args: [] });
		expect(result.status).toBe(0);
		expect(result.signal).toBeNull();
		expect(result.error).toBeUndefined();
	});
});

describe("formatEditorOutcome", () => {
	const editor = { cmd: "vi", args: [] };

	it("formats a spawn failure with an EDITOR hint", () => {
		const line = formatEditorOutcome("alpha", "soul", "/p/alpha/SOUL.md", editor, {
			status: null,
			error: "spawnSync vi ENOENT",
		});
		expect(line).toContain("could not start editor 'vi'");
		expect(line).toContain("EDITOR");
		expect(line).not.toContain("edited");
	});

	it("formats a signal termination", () => {
		const line = formatEditorOutcome("alpha", "soul", "/p/alpha/SOUL.md", editor, {
			status: null,
			signal: "SIGTERM",
		});
		expect(line).toContain("terminated by SIGTERM");
		expect(line).not.toContain("edited");
	});

	it("formats a clean edit", () => {
		const line = formatEditorOutcome("alpha", "soul", "/p/alpha/SOUL.md", editor, { status: 0 });
		expect(line).toBe("edited 'alpha' SOUL.md (/p/alpha/SOUL.md)");
	});

	it("formats a non-zero exit", () => {
		const line = formatEditorOutcome("alpha", "settings", "/p/alpha/settings.json", editor, { status: 7 });
		expect(line).toBe("editor exited with status 7");
	});
});
