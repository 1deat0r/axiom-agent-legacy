import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_COMMAND_NAMES } from "../src/cli/command-registry.js";
import { completionCandidates, emitBash, emitZsh, handleCompletionCommand } from "../src/cli/completion-command.js";

describe("completionCandidates", () => {
	it("yields every top-level command on an empty line", async () => {
		const candidates = await completionCandidates([]);
		for (const command of PUBLIC_COMMAND_NAMES) {
			expect(candidates).toContain(command);
		}
	});

	it("yields top-level commands filtered by the current prefix", async () => {
		const candidates = await completionCandidates(["pr"]);
		expect(candidates).toContain("profile");
		expect(candidates).toContain("projects");
		expect(candidates).not.toContain("shutdown");
	});

	it("yields the profile subcommands", async () => {
		expect(await completionCandidates(["profile", ""])).toEqual(["create", "edit", "list", "switch"]);
	});

	it("yields the projects subcommands", async () => {
		expect(await completionCandidates(["projects", ""])).toEqual(["add", "rm"]);
	});

	it("yields the peers subcommands", async () => {
		expect(await completionCandidates(["peers", ""])).toEqual(["group", "inbox", "list", "msg"]);
	});

	it("yields the completion shells", async () => {
		expect(await completionCandidates(["completion", ""])).toEqual(["bash", "zsh"]);
	});

	it("yields existing project names for projects rm", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-completion-"));
		try {
			await mkdir(join(dir, "projects", "alpha"), { recursive: true });
			await mkdir(join(dir, "projects", "beta"), { recursive: true });
			const candidates = await completionCandidates(["projects", "rm", "a"], dir);
			expect(candidates).toContain("alpha");
			expect(candidates).not.toContain("beta");
			expect(await completionCandidates(["projects", "add"], dir)).toEqual(["add"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("completion command routing", () => {
	it("ignores non-completion commands", async () => {
		expect(await handleCompletionCommand(["chat", "hello"])).toBe(false);
	});

	it("prints the bash completion script", async () => {
		const out: string[] = [];
		const handled = await handleCompletionCommand(["completion", "bash"], { stdout: (s) => out.push(s) });
		expect(handled).toBe(true);
		const script = out.join("\n");
		expect(script).toContain("complete -F _axiom_completion axiom");
		expect(script).toContain("completion candidates");
	});

	it("prints the zsh completion script", async () => {
		const out: string[] = [];
		const handled = await handleCompletionCommand(["completion", "zsh"], { stdout: (s) => out.push(s) });
		expect(handled).toBe(true);
		const script = out.join("\n");
		expect(script).toContain("compdef _axiom_completion axiom");
		expect(script).toContain("completion candidates");
	});

	it("prints one candidate per line for candidates", async () => {
		const out: string[] = [];
		const handled = await handleCompletionCommand(["completion", "candidates", "--", "projects", ""], {
			stdout: (s) => out.push(s),
		});
		expect(handled).toBe(true);
		expect(out).toEqual(["add", "rm"]);
	});

	it("prints usage for an unknown shell", async () => {
		const out: string[] = [];
		await handleCompletionCommand(["completion", "fish"], { stdout: (s) => out.push(s) });
		expect(out.join(" ")).toMatch(/Usage/);
	});
});

describe("completion script shape", () => {
	it("bash emits a compgen-driven function", () => {
		expect(emitBash()).toContain("compgen -W");
		expect(emitBash()).toContain("COMP_WORDS");
	});

	it("zsh emits a compdef-driven function", () => {
		expect(emitZsh()).toContain("_describe");
		expect(emitZsh()).toContain("#compdef axiom");
	});
});
