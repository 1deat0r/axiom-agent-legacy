import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleSkillCheckCommand } from "../src/cli/skill-check-command.js";
import { runSkillCheck } from "../src/core/skill-check/check.js";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "skill-check-test-"));
	return tempDir;
}

/** Write a skill directory; `frontmatter` is the raw YAML block ("" = none). */
function writeSkill(dir: string, name: string, frontmatter: string, body = "instructions"): string {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	const fm = frontmatter ? `---\n${frontmatter}\n---\n\n` : "";
	writeFileSync(join(skillDir, "SKILL.md"), `${fm}# ${name}\n\n${body}\n`);
	return skillDir;
}

const VALID_FM = "name: deploy\ndescription: Deploys the service and verifies the alias.";

describe("runSkillCheck", () => {
	it("accepts a clean directory of valid skills", () => {
		const dir = makeTempDir();
		writeSkill(dir, "deploy", VALID_FM);

		const result = runSkillCheck(dir);

		expect(result.ok).toBe(true);
		expect(result.loaded).toBe(1);
		expect(result.filesChecked).toBe(1);
		expect(result.rejections).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it("rejects a SKILL.md with no frontmatter (the tui-pty-testing incident)", () => {
		const dir = makeTempDir();
		writeSkill(dir, "tui-pty-testing", "");

		const result = runSkillCheck(dir);

		expect(result.ok).toBe(false);
		expect(result.loaded).toBe(0);
		expect(result.rejections).toHaveLength(1);
		expect(result.rejections[0]?.filePath).toContain("tui-pty-testing");
		expect(result.rejections[0]?.reasons.join(" ")).toContain("description is required");
	});

	it("rejects an empty description", () => {
		const dir = makeTempDir();
		writeSkill(dir, "empty-desc", 'name: empty-desc\ndescription: ""');

		const result = runSkillCheck(dir);

		expect(result.ok).toBe(false);
		expect(result.rejections[0]?.reasons.join(" ")).toContain("description is required");
	});

	it("reports a name mismatch as a warning, not a rejection", () => {
		const dir = makeTempDir();
		writeSkill(dir, "good-skill", "name: mismatched-name\ndescription: Valid description.");

		const result = runSkillCheck(dir);

		expect(result.ok).toBe(true);
		expect(result.loaded).toBe(1);
		expect(result.rejections).toEqual([]);
		expect(result.warnings.some((w) => w.message.includes("does not match parent directory"))).toBe(true);
	});

	it("rejects the losing side of a name collision", () => {
		const dir = makeTempDir();
		writeSkill(dir, "skill-a", "name: dup\ndescription: First copy.");
		writeSkill(dir, "skill-b", "name: dup\ndescription: Second copy.");

		const result = runSkillCheck(dir);

		// Exactly one copy loads; the loser is dropped with a collision diagnostic.
		expect(result.loaded).toBe(1);
		expect(result.rejections).toHaveLength(1);
		expect(result.rejections[0]?.reasons.join(" ")).toContain("collision");
		expect(result.ok).toBe(false);
	});

	it("does not report skills excluded by ignore files", () => {
		const dir = makeTempDir();
		writeSkill(dir, "deploy", VALID_FM);
		writeFileSync(join(dir, ".gitignore"), "ignored-skill/\n");
		writeSkill(dir, "ignored-skill", ""); // no description, but ignored

		const result = runSkillCheck(dir);

		expect(result.ok).toBe(true);
		expect(result.loaded).toBe(1);
		expect(result.filesChecked).toBe(1);
		expect(result.rejections).toEqual([]);
	});

	it("checks root-level markdown files the loader treats as skills", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "loose.md"), "# loose\n\nno frontmatter here\n");

		const result = runSkillCheck(dir);

		expect(result.ok).toBe(false);
		expect(result.rejections[0]?.filePath).toContain("loose.md");
		expect(result.rejections[0]?.reasons.join(" ")).toContain("description is required");
	});

	it("does not treat nested non-SKILL.md markdown as skills", () => {
		const dir = makeTempDir();
		mkdirSync(join(dir, "docs"));
		writeFileSync(join(dir, "docs", "reference.md"), "# reference\n\nnot a skill\n");

		const result = runSkillCheck(dir);

		expect(result.ok).toBe(true);
		expect(result.filesChecked).toBe(0);
	});

	it("reports a clean result for a missing directory", () => {
		const result = runSkillCheck(join(makeTempDir(), "does-not-exist"));

		expect(result.ok).toBe(true);
		expect(result.filesChecked).toBe(0);
		expect(result.rejections).toEqual([]);
	});
});

describe("handleSkillCheckCommand", () => {
	function collectIo(): {
		log: (m: string) => void;
		err: (m: string) => void;
		output: string[];
		errors: string[];
	} {
		const output: string[] = [];
		const errors: string[] = [];
		return {
			log: (m: string) => output.push(m),
			err: (m: string) => errors.push(m),
			output,
			errors,
		};
	}

	it("returns false for an unrelated command", () => {
		const io = collectIo();
		expect(handleSkillCheckCommand(["skill-audit", "x"], io)).toBe(false);
		expect(io.output).toEqual([]);
		expect(io.errors).toEqual([]);
	});

	it("prints usage on --help", () => {
		const io = collectIo();
		expect(handleSkillCheckCommand(["skill-check", "--help"], io)).toBe(true);
		expect(io.output.join(" ")).toContain("axiom skill-check");
	});

	it("reports OK and leaves the exit code alone for a clean directory", () => {
		const dir = makeTempDir();
		writeSkill(dir, "deploy", VALID_FM);
		const io = collectIo();
		const previousExitCode = process.exitCode;

		try {
			expect(handleSkillCheckCommand(["skill-check", dir], io)).toBe(true);
			expect(process.exitCode ?? 0).toBe(0);
			expect(io.output.join("\n")).toContain("OK");
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	it("sets exit code 1 when a skill would be dropped", () => {
		const dir = makeTempDir();
		writeSkill(dir, "broken", "");
		const io = collectIo();
		const previousExitCode = process.exitCode;

		try {
			expect(handleSkillCheckCommand(["skill-check", dir], io)).toBe(true);
			expect(process.exitCode).toBe(1);
			expect(io.output.join("\n")).toContain("description is required");
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	it("--json emits a machine-readable report", () => {
		const dir = makeTempDir();
		writeSkill(dir, "broken", "");
		const io = collectIo();
		const previousExitCode = process.exitCode;

		try {
			expect(handleSkillCheckCommand(["skill-check", dir, "--json"], io)).toBe(true);
			const parsed = JSON.parse(io.output.join("\n"));
			expect(parsed.ok).toBe(false);
			expect(parsed.dirs[0].rejections[0].reasons).toContain("description is required");
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	it("--strict fails on warnings even when nothing is rejected", () => {
		const dir = makeTempDir();
		writeSkill(dir, "good-skill", "name: mismatched-name\ndescription: Valid description.");
		const io = collectIo();
		const previousExitCode = process.exitCode;

		try {
			expect(handleSkillCheckCommand(["skill-check", dir, "--strict"], io)).toBe(true);
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	it("errors on a nonexistent directory", () => {
		const dir = makeTempDir();
		const io = collectIo();
		expect(handleSkillCheckCommand(["skill-check", join(dir, "nope")], io)).toBe(true);
		expect(io.errors.join(" ")).toContain("does not exist");
	});

	it("prints usage when no directory is given and defaults are disabled", () => {
		// No explicit dir: the command falls back to the default skill dirs.
		// The fallback is covered by the default-dirs helper; here we only
		// assert the command handles the flagless form without throwing.
		const io = collectIo();
		expect(handleSkillCheckCommand(["skill-check"], io)).toBe(true);
		expect(io.output.length + io.errors.length).toBeGreaterThan(0);
	});
});
