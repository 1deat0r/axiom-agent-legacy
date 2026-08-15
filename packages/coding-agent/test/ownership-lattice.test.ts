/**
 * Ownership lattice (ADR-0081, issue #55) — red-first fence.
 *
 * The lattice classifies a write target into pin / protected / curator and
 * admits it only when the actor and operation are allowed. The learning actor
 * (the automatic loop: memory consolidation, the skill-capture hook) writes
 * silently only what it owns — curator-managed territory — through a
 * whitelisted toolset; bundled/pinned work is untouchable by every
 * lattice-routed write and user-owned work is refused with the manual
 * alternative. The install primitive is the first consumer: a captured skill
 * installs only into a curator-managed live skills directory.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.js";
import {
	admitWrite,
	classifyPath,
	defaultLatticeConfig,
	installCapturedSkill,
	type LatticeConfig,
	LEARNING_ACTOR_TOOLSET,
} from "../src/core/ownership-lattice/index.js";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "ownership-lattice-"));
	return tempDir;
}

/** A home laid out like a real axiom install: curator dirs under the axiom
 *  home, user skills under the agent dir, project skills under cwd, and a
 *  bundled skills dir standing in for the package's shipped skills. */
function makeLattice(): {
	config: LatticeConfig;
	axiomHome: string;
	agentDir: string;
	cwd: string;
	bundled: string;
	harness: string;
} {
	const root = makeTempDir();
	const axiomHome = join(root, "home");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const bundled = join(root, "bundled-skills");
	const harness = join(agentDir, "harness");
	mkdirSync(join(axiomHome, "captured-skills"), { recursive: true });
	mkdirSync(join(axiomHome, "curator-skills"), { recursive: true });
	mkdirSync(join(axiomHome, "consolidation", "pending"), { recursive: true });
	mkdirSync(join(agentDir, "skills"), { recursive: true });
	mkdirSync(join(cwd, CONFIG_DIR_NAME, "skills"), { recursive: true });
	mkdirSync(join(bundled), { recursive: true });
	mkdirSync(join(cwd, "test"), { recursive: true });
	mkdirSync(join(cwd, "packages"), { recursive: true });
	mkdirSync(harness, { recursive: true });
	writeFileSync(join(cwd, "SOUL.md"), "the creed", "utf-8");
	writeFileSync(join(agentDir, "SOUL.md"), "the profile soul", "utf-8");
	writeFileSync(join(axiomHome, "consolidation", "audit.jsonl"), "", "utf-8");
	const config = defaultLatticeConfig({
		axiomHome,
		agentDir,
		cwd,
		bundledSkillsDir: bundled,
		harnessStateDir: harness,
	});
	return { config, axiomHome, agentDir, cwd, bundled, harness };
}

/** A real, loader-valid skill directory (name === dirname, description present). */
function writeValidSkill(dir: string, name: string): string {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: A demo skill for lattice install tests.\n---\n\nBody.\n`,
		"utf-8",
	);
	return skillDir;
}

describe("classifyPath", () => {
	it("classifies the capture directory and everything under it as curator", () => {
		const { config, axiomHome } = makeLattice();
		expect(classifyPath(join(axiomHome, "captured-skills"), config).layer).toBe("curator");
		expect(classifyPath(join(axiomHome, "captured-skills", "demo", "SKILL.md"), config).layer).toBe("curator");
	});

	it("classifies the curator live skills directory as curator", () => {
		const { config, axiomHome } = makeLattice();
		expect(classifyPath(join(axiomHome, "curator-skills"), config).layer).toBe("curator");
	});

	it("classifies consolidation staging as curator but the witness audit log as pin", () => {
		const { config, axiomHome } = makeLattice();
		expect(classifyPath(join(axiomHome, "consolidation", "pending", "mc_1.json"), config).layer).toBe("curator");
		expect(classifyPath(join(axiomHome, "consolidation", "audit.jsonl"), config).layer).toBe("pin");
	});

	it("classifies the harness memory store as curator", () => {
		const { config, harness } = makeLattice();
		expect(classifyPath(join(harness, "harness_state.json"), config).layer).toBe("curator");
	});

	it("classifies user skills as protected", () => {
		const { config, agentDir } = makeLattice();
		expect(classifyPath(join(agentDir, "skills"), config).layer).toBe("protected");
		expect(classifyPath(join(agentDir, "skills", "demo", "SKILL.md"), config).layer).toBe("protected");
	});

	it("classifies project skills as protected", () => {
		const { config, cwd } = makeLattice();
		expect(classifyPath(join(cwd, CONFIG_DIR_NAME, "skills", "demo"), config).layer).toBe("protected");
	});

	it("classifies bundled skills as pin", () => {
		const { config, bundled } = makeLattice();
		expect(classifyPath(join(bundled, "ast-grep"), config).layer).toBe("pin");
	});

	it("classifies the repo floor as pin: SOUL.md, the test suite, the packages tree", () => {
		const { config, cwd } = makeLattice();
		expect(classifyPath(join(cwd, "SOUL.md"), config).layer).toBe("pin");
		expect(classifyPath(join(cwd, "test", "x.test.ts"), config).layer).toBe("pin");
		expect(classifyPath(join(cwd, "packages", "coding-agent", "src"), config).layer).toBe("pin");
	});

	it("classifies the profile soul as pin", () => {
		const { config, agentDir } = makeLattice();
		expect(classifyPath(join(agentDir, "SOUL.md"), config).layer).toBe("pin");
	});

	it("does not bleed a file root into sibling names (boundary-safe matching)", () => {
		const { config, cwd } = makeLattice();
		expect(classifyPath(`${join(cwd, "SOUL.md")}.bak`, config).layer).toBe("outside");
		expect(classifyPath(join(cwd, "SOUL.md-extra"), config).layer).toBe("outside");
	});

	it("does not bleed a directory root into prefixed sibling names", () => {
		const { config, axiomHome } = makeLattice();
		expect(classifyPath(`${join(axiomHome, "curator-skills")}-evil`, config).layer).toBe("outside");
	});

	it("classifies unmapped paths under known parents as outside", () => {
		const { config, agentDir, axiomHome } = makeLattice();
		expect(classifyPath(join(agentDir, "settings.json"), config).layer).toBe("outside");
		expect(classifyPath(join(axiomHome, "other"), config).layer).toBe("outside");
		expect(classifyPath("/etc/passwd", config).layer).toBe("outside");
	});

	it("resolves the most specific root (longest prefix wins)", () => {
		const a = join(makeTempDir(), "a");
		const b = join(a, "b");
		const config: LatticeConfig = {
			roots: [
				{ path: a, layer: "curator" },
				{ path: b, layer: "pin" },
			],
		};
		expect(classifyPath(join(a, "x"), config).layer).toBe("curator");
		expect(classifyPath(join(b, "c"), config).layer).toBe("pin");
	});

	it("resolves a layer tie toward the stricter layer", () => {
		const p = join(makeTempDir(), "p");
		const config: LatticeConfig = {
			roots: [
				{ path: p, layer: "curator" },
				{ path: p, layer: "protected" },
			],
		};
		expect(classifyPath(join(p, "x"), config).layer).toBe("protected");
	});
});

describe("LEARNING_ACTOR_TOOLSET", () => {
	it("whitelists the loop's sanctioned operations and nothing broader", () => {
		expect(LEARNING_ACTOR_TOOLSET).toContain("memory.apply");
		expect(LEARNING_ACTOR_TOOLSET).toContain("memory.stage");
		expect(LEARNING_ACTOR_TOOLSET).toContain("skill.capture");
		expect(LEARNING_ACTOR_TOOLSET).toContain("skill.install");
		expect(LEARNING_ACTOR_TOOLSET).not.toContain("skill.delete");
		expect(LEARNING_ACTOR_TOOLSET).not.toContain("file.write");
	});
});

describe("admitWrite", () => {
	it("admits a learning-actor write into curator territory with a whitelisted operation", () => {
		const { config, axiomHome } = makeLattice();
		const verdict = admitWrite(
			join(axiomHome, "captured-skills", "demo"),
			{ actor: "learning", operation: "skill.capture" },
			config,
		);
		expect(verdict.admitted).toBe(true);
		if (verdict.admitted) expect(verdict.layer).toBe("curator");
	});

	it("refuses a learning-actor write into curator territory with a non-whitelisted operation", () => {
		const { config, axiomHome } = makeLattice();
		const verdict = admitWrite(
			join(axiomHome, "captured-skills", "demo"),
			{ actor: "learning", operation: "skill.delete" },
			config,
		);
		expect(verdict.admitted).toBe(false);
		if (!verdict.admitted) expect(verdict.reason).toMatch(/whitelist/);
	});

	it("refuses a learning-actor write into protected territory and names the layer", () => {
		const { config, agentDir } = makeLattice();
		const verdict = admitWrite(
			join(agentDir, "skills", "demo"),
			{ actor: "learning", operation: "skill.install" },
			config,
		);
		expect(verdict.admitted).toBe(false);
		if (!verdict.admitted) {
			expect(verdict.layer).toBe("protected");
			expect(verdict.reason).toMatch(/user-owned|operator/);
		}
	});

	it("refuses a learning-actor write into unmapped territory (deny by default)", () => {
		const { config, agentDir } = makeLattice();
		const verdict = admitWrite(
			join(agentDir, "settings.json"),
			{ actor: "learning", operation: "memory.apply" },
			config,
		);
		expect(verdict.admitted).toBe(false);
		if (!verdict.admitted) expect(verdict.layer).toBe("outside");
	});

	it("refuses every actor on pinned territory (the floor)", () => {
		const { config, cwd } = makeLattice();
		for (const actor of ["learning", "operator"] as const) {
			const verdict = admitWrite(join(cwd, "SOUL.md"), { actor, operation: "file.write" }, config);
			expect(verdict.admitted).toBe(false);
			if (!verdict.admitted) expect(verdict.layer).toBe("pin");
		}
	});

	it("admits operator-routed writes into protected territory", () => {
		const { config, agentDir } = makeLattice();
		const verdict = admitWrite(
			join(agentDir, "skills", "demo"),
			{ actor: "operator", operation: "skill.install" },
			config,
		);
		expect(verdict.admitted).toBe(true);
		if (verdict.admitted) expect(verdict.layer).toBe("protected");
	});

	it("refuses operator-routed writes into unmapped territory (fail closed)", () => {
		const { config, axiomHome } = makeLattice();
		const verdict = admitWrite(join(axiomHome, "other"), { actor: "operator", operation: "skill.install" }, config);
		expect(verdict.admitted).toBe(false);
	});
});

describe("installCapturedSkill", () => {
	it("installs a capture into the curator live skills directory and verifies it loads", () => {
		const { config, axiomHome } = makeLattice();
		const captured = join(axiomHome, "captured-skills");
		writeValidSkill(captured, "demo-skill");
		const result = installCapturedSkill(
			{ fromDir: captured, name: "demo-skill", toDir: join(axiomHome, "curator-skills") },
			config,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.kind).toBe("installed");
			expect(result.to).toBe(join(axiomHome, "curator-skills"));
			expect(existsSync(join(axiomHome, "curator-skills", "demo-skill", "SKILL.md"))).toBe(true);
			expect(readFileSync(join(axiomHome, "curator-skills", "demo-skill", "SKILL.md"), "utf-8")).toContain(
				"name: demo-skill",
			);
			expect(result.diagnostics).toEqual([]);
		}
	});

	it("refuses to install into protected user skills and returns the manual alternative", () => {
		const { config, axiomHome, agentDir } = makeLattice();
		const captured = join(axiomHome, "captured-skills");
		const source = writeValidSkill(captured, "demo-skill");
		const toDir = join(agentDir, "skills");
		const result = installCapturedSkill({ fromDir: captured, name: "demo-skill", toDir }, config);
		expect(result.ok).toBe(false);
		if (!result.ok && result.kind === "refused") {
			expect(result.layer).toBe("protected");
			expect(result.manual).toContain(source);
			expect(result.manual).toContain(toDir);
		}
		expect(existsSync(join(toDir, "demo-skill"))).toBe(false);
	});

	it("refuses hard on pinned and unmapped targets, with no manual alternative", () => {
		const { config, axiomHome, bundled } = makeLattice();
		const captured = join(axiomHome, "captured-skills");
		writeValidSkill(captured, "demo-skill");
		for (const toDir of [bundled, join(axiomHome, "other")]) {
			const result = installCapturedSkill({ fromDir: captured, name: "demo-skill", toDir }, config);
			expect(result.ok).toBe(false);
			if (!result.ok && result.kind === "refused") expect(result.manual).toBeUndefined();
		}
	});

	it("refuses when the capture source is not curator territory", () => {
		const { config, agentDir, axiomHome } = makeLattice();
		const userSkills = join(agentDir, "skills");
		writeValidSkill(userSkills, "demo-skill");
		const result = installCapturedSkill(
			{ fromDir: userSkills, name: "demo-skill", toDir: join(axiomHome, "curator-skills") },
			config,
		);
		expect(result.ok).toBe(false);
		if (!result.ok && result.kind === "refused") expect(result.layer).toBe("protected");
	});

	it("reports a missing capture source", () => {
		const { config, axiomHome } = makeLattice();
		const result = installCapturedSkill(
			{
				fromDir: join(axiomHome, "captured-skills"),
				name: "never-captured",
				toDir: join(axiomHome, "curator-skills"),
			},
			config,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.kind).toBe("missing");
	});

	it("refuses to overwrite an already-installed skill", () => {
		const { config, axiomHome } = makeLattice();
		const captured = join(axiomHome, "captured-skills");
		writeValidSkill(captured, "demo-skill");
		const toDir = join(axiomHome, "curator-skills");
		expect(installCapturedSkill({ fromDir: captured, name: "demo-skill", toDir }, config).ok).toBe(true);
		const second = installCapturedSkill({ fromDir: captured, name: "demo-skill", toDir }, config);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.kind).toBe("exists");
	});

	it("fails when the copied skill does not pass the real loader", () => {
		const { config, axiomHome } = makeLattice();
		const captured = join(axiomHome, "captured-skills");
		const broken = join(captured, "broken-skill");
		mkdirSync(broken, { recursive: true });
		writeFileSync(join(broken, "SKILL.md"), "---\nname: broken-skill\n---\n\nNo description here.\n", "utf-8");
		const result = installCapturedSkill(
			{ fromDir: captured, name: "broken-skill", toDir: join(axiomHome, "curator-skills") },
			config,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.kind).toBe("error");
	});
});
