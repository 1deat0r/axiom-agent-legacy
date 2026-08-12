import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleSkillCaptureCommand, parseSkillCaptureArgs, readStepsFile } from "../src/cli/skill-capture-command.js";
import {
	buildSkillDocument,
	persistCapturedSkill,
	slugify,
	verifyCapturedSkill,
} from "../src/core/skill-capture/index.js";
import type { TaskCapture } from "../src/core/skill-capture/types.js";
import { parseFrontmatter } from "../src/utils/frontmatter.js";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "skill-capture-test-"));
	return tempDir;
}

function capture(overrides: Partial<TaskCapture> = {}): TaskCapture {
	return {
		name: "Deploy the Lambda!",
		description: "Deploys a serverless function to AWS and verifies the alias.",
		prompt: "Deploy the payment-lambda service to staging.",
		steps: [
			{ summary: "Build the bundle", detail: "npm run build" },
			{ summary: "Deploy with sam deploy", detail: "sam deploy --guided" },
		],
		provenance: { source: "session", createdAt: "2026-08-12T00:00:00.000Z", sessionId: "abc123" },
		...overrides,
	};
}

describe("slugify", () => {
	it("reduces a title to lowercase a-z0-9 hyphen-separated", () => {
		expect(slugify("Deploy the Lambda!")).toBe("deploy-the-lambda");
	});
	it("collapses whitespace and non-alphanumerics to single hyphens", () => {
		expect(slugify("  Foo   Bar  ")).toBe("foo-bar");
	});
	it("trims leading/trailing hyphens", () => {
		expect(slugify("-hello-")).toBe("hello");
	});
	it("returns empty for input with no valid chars", () => {
		expect(slugify("!!!")).toBe("");
	});
	it("caps at the max name length", () => {
		expect(slugify("a".repeat(200))).toHaveLength(64);
	});
});

describe("buildSkillDocument", () => {
	it("builds a valid, provenance-bearing skill that bundles prompt + steps", () => {
		const result = buildSkillDocument(capture());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { document } = result;
		expect(document.directoryName).toBe(document.name);
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(document.markdown);
		expect(frontmatter.name).toBe("deploy-the-lambda");
		expect(frontmatter.description).toBe("Deploys a serverless function to AWS and verifies the alias.");
		const metadata = frontmatter.metadata as { provenance?: Record<string, unknown> };
		expect(metadata.provenance).toEqual({
			source: "session",
			createdAt: "2026-08-12T00:00:00.000Z",
			sessionId: "abc123",
		});
		expect(body).toContain("Deploy the payment-lambda service to staging.");
		expect(body).toContain("1. Build the bundle");
		expect(body).toContain("2. Deploy with sam deploy");
		expect(body).toContain("npm run build");
	});

	it("rejects an empty description (loader-droppable)", () => {
		const result = buildSkillDocument(capture({ description: "   " }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join(" ")).toContain("description is required");
	});

	it("rejects a name that slugs to empty", () => {
		const result = buildSkillDocument(capture({ name: "!!!" }));
		expect(result.ok).toBe(false);
	});

	it("normalizes an oversized name to a valid slug under the cap", () => {
		const result = buildSkillDocument(capture({ name: `a${"b".repeat(70)}` }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.document.name.length).toBeLessThanOrEqual(64);
		expect(/^[a-z0-9-]+$/.test(result.document.name)).toBe(true);
	});

	it("rejects a missing prompt", () => {
		const result = buildSkillDocument(capture({ prompt: "" }));
		expect(result.ok).toBe(false);
	});

	it("rejects missing provenance source", () => {
		const result = buildSkillDocument(capture({ provenance: { source: "", createdAt: "2026-08-12T00:00:00.000Z" } }));
		expect(result.ok).toBe(false);
	});

	it("round-trips provenance through the written file", () => {
		const built = buildSkillDocument(capture());
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		const reparsed = parseFrontmatter<Record<string, unknown>>(built.document.markdown);
		const provenance = (reparsed.frontmatter.metadata as { provenance: { createdAt: string } }).provenance;
		expect(provenance.createdAt).toBe("2026-08-12T00:00:00.000Z");
	});
});

describe("persistCapturedSkill", () => {
	it("writes the skill and refuses to overwrite an existing one", () => {
		const dir = makeTempDir();
		const built = buildSkillDocument(capture());
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		const first = persistCapturedSkill(dir, built.document);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(existsSync(first.path)).toBe(true);
		expect(readFileSync(first.path, "utf-8")).toBe(built.document.markdown);

		const second = persistCapturedSkill(dir, built.document);
		expect(second.ok).toBe(false);
		if (!second.ok && second.code !== "exists") return;
		// original content untouched
		expect(readFileSync(second.path, "utf-8")).toBe(built.document.markdown);
	});
});

describe("verifyCapturedSkill", () => {
	it("confirms a persisted skill loads with zero diagnostics (non-tautological)", () => {
		const dir = makeTempDir();
		const built = buildSkillDocument(capture());
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		persistCapturedSkill(dir, built.document);
		const verified = verifyCapturedSkill(dir, built.document.name);
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.skill.name).toBe(built.document.name);
		expect(verified.skill.description).toBe("Deploys a serverless function to AWS and verifies the alias.");
		expect(verified.diagnostics).toEqual([]);
		expect(verified.skill.filePath).toBe(join(dir, built.document.name, "SKILL.md"));
	});

	it("reports not-found when the skill is absent", () => {
		const dir = makeTempDir();
		const verified = verifyCapturedSkill(dir, "bogus");
		expect(verified.ok).toBe(false);
	});
});

describe("parseSkillCaptureArgs", () => {
	it("parses the happy path", () => {
		const parsed = parseSkillCaptureArgs([
			"skill-capture",
			"--prompt",
			"do the thing",
			"--description",
			"Does the thing",
			"--out",
			"/tmp/out",
			"--steps-file",
			"steps.json",
			"--source",
			"session",
		]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.options.prompt).toBe("do the thing");
		expect(parsed.options.out).toBe("/tmp/out");
		expect(parsed.options.source).toBe("session");
	});

	it("errors when required flags are missing", () => {
		const parsed = parseSkillCaptureArgs(["skill-capture", "--prompt", "x"]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.errors.join(" ")).toContain("--description");
		expect(parsed.errors.join(" ")).toContain("--out");
	});

	it("treats --help as help", () => {
		const parsed = parseSkillCaptureArgs(["skill-capture", "--help"]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.help).toBe(true);
	});
});

describe("readStepsFile", () => {
	it("reads a JSON array of strings and {summary, detail}", () => {
		const dir = makeTempDir();
		const file = join(dir, "steps.json");
		writeFileSync(file, JSON.stringify(["build", { summary: "deploy", detail: "sam deploy" }]), "utf-8");
		const result = readStepsFile(file);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.steps).toEqual([{ summary: "build" }, { summary: "deploy", detail: "sam deploy" }]);
	});

	it("reports invalid JSON", () => {
		const dir = makeTempDir();
		const file = join(dir, "bad.json");
		writeFileSync(file, "{nope", "utf-8");
		const result = readStepsFile(file);
		expect(result.ok).toBe(false);
	});
});

describe("handleSkillCaptureCommand", () => {
	it("captures, persists, verifies, and offers a reusable skill", () => {
		const dir = makeTempDir();
		const logs: string[] = [];
		const errs: string[] = [];
		const io = { log: (m: string) => logs.push(m), err: (m: string) => errs.push(m) };
		const stepsFile = join(dir, "steps.json");
		writeFileSync(
			stepsFile,
			JSON.stringify(["Build the SDK layer", { summary: "Swap gateway", detail: "update routes" }]),
			"utf-8",
		);
		const handled = handleSkillCaptureCommand(
			[
				"skill-capture",
				"--prompt",
				"Refactor the payment service to use Stripe.",
				"--description",
				"Refactors services to Stripe payments.",
				"--out",
				dir,
				"--name",
				"stripe-refactor",
				"--steps-file",
				stepsFile,
				"--source",
				"agent",
			],
			io,
		);
		expect(handled).toBe(true);
		expect(errs).toEqual([]);
		expect(logs.join("\n")).toContain("Captured reusable skill");
		expect(logs.join("\n")).toContain("stripe-refactor");
		expect(existsSync(join(dir, "stripe-refactor", "SKILL.md"))).toBe(true);
		const verified = verifyCapturedSkill(dir, "stripe-refactor");
		expect(verified.ok).toBe(true);
		if (verified.ok) expect(verified.diagnostics).toEqual([]);
	});

	it("refuses to overwrite an existing skill", () => {
		const dir = makeTempDir();
		const errs: string[] = [];
		const io = { log: () => {}, err: (m: string) => errs.push(m) };
		// Create the skill through the command, then run again against the same out dir.
		handleSkillCaptureCommand(
			["skill-capture", "--prompt", "p", "--description", "d", "--out", dir, "--name", "dup"],
			io,
		);
		handleSkillCaptureCommand(
			["skill-capture", "--prompt", "p", "--description", "d", "--out", dir, "--name", "dup"],
			io,
		);
		expect(errs.join("\n")).toContain("refusing to overwrite");
	});

	it("prints usage for --help", () => {
		const logs: string[] = [];
		const handled = handleSkillCaptureCommand(["skill-capture", "--help"], {
			log: (m) => logs.push(m),
			err: () => {},
		});
		expect(handled).toBe(true);
		expect(logs.join("\n")).toContain("axiom skill-capture");
	});

	it("returns false for non skill-capture commands", () => {
		const handled = handleSkillCaptureCommand(["gateway"], { log: () => {}, err: () => {} });
		expect(handled).toBe(false);
	});
});
