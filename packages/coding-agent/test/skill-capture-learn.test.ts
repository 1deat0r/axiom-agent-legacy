import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskTrace } from "../src/core/skill-capture/index.js";
import { buildLearnCapture, parseLearnCommandOptions, runLearnCapture } from "../src/core/skill-capture/learn.js";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "skill-capture-learn-"));
	return tempDir;
}

const reusableTrace = (): TaskTrace => ({
	prompt: "Set up a reusable CI pipeline for every new service",
	steps: [{ summary: "a" }, { summary: "b" }, { summary: "c" }, { summary: "d" }, { summary: "e" }, { summary: "f" }],
	completed: true,
});

const thinTrace = (): TaskTrace => ({ prompt: "just a one-time scratch task", steps: [], completed: true });

const highScoreButIncompleteTrace = (): TaskTrace => ({
	prompt: "Set up a reusable CI pipeline for every new service",
	steps: [{ summary: "a" }, { summary: "b" }, { summary: "c" }, { summary: "d" }, { summary: "e" }, { summary: "f" }],
	completed: false,
});

describe("parseLearnCommandOptions", () => {
	it("accepts no arguments as a normal (unforced) learn", () => {
		expect(parseLearnCommandOptions("")).toEqual({ force: false, install: false });
	});
	it("accepts --force", () => {
		expect(parseLearnCommandOptions("--force")).toEqual({ force: true, install: false });
		expect(parseLearnCommandOptions("  --force  ")).toEqual({ force: true, install: false });
	});
	it("accepts --install (the lattice-routed curator install, ADR-0081)", () => {
		expect(parseLearnCommandOptions("--install")).toEqual({ force: false, install: true });
		expect(parseLearnCommandOptions("--force --install")).toEqual({ force: true, install: true });
		expect(parseLearnCommandOptions("--install --force")).toEqual({ force: true, install: true });
	});
	it("rejects unknown options and trailing text with the usage line", () => {
		expect(() => parseLearnCommandOptions("--name foo")).toThrow("Usage: /learn [--force] [--install]");
		expect(() => parseLearnCommandOptions("--force extra")).toThrow("Usage: /learn [--force] [--install]");
		expect(() => parseLearnCommandOptions("--force --install extra")).toThrow("Usage: /learn [--force] [--install]");
		expect(() => parseLearnCommandOptions("force")).toThrow("Usage: /learn [--force] [--install]");
	});
});

describe("buildLearnCapture", () => {
	it("records provenance source 'learn' with the /learn trigger and the session id", () => {
		const capture = buildLearnCapture(
			{ ...reusableTrace(), metadata: { sessionId: "sess-42" } },
			() => new Date("2026-08-15T10:00:00.000Z"),
		);
		expect(capture.provenance).toEqual({
			source: "learn",
			createdAt: "2026-08-15T10:00:00.000Z",
			sessionId: "sess-42",
			trigger: "/learn",
		});
		expect(capture.name).toBe("set-up-a-reusable-ci-pipeline-for-every-new-service");
		expect(capture.description).toContain("Set up a reusable CI pipeline");
	});
	it("omits the session id from provenance when the trace has no metadata", () => {
		const capture = buildLearnCapture(reusableTrace(), () => new Date("2026-08-15T10:00:00.000Z"));
		expect(capture.provenance.sessionId).toBeUndefined();
		expect(capture.provenance.trigger).toBe("/learn");
	});
});

describe("runLearnCapture", () => {
	it("captures a flagged reusable task: persist, verify with the real loader, zero diagnostics", () => {
		const dir = makeTempDir();
		const result = runLearnCapture(reusableTrace(), {
			captureDir: dir,
			now: () => new Date("2026-08-15T10:00:00.000Z"),
		});
		expect(result.kind).toBe("captured");
		if (result.kind !== "captured") return;
		expect(result.diagnostics).toEqual([]);
		expect(result.name).toBe("set-up-a-reusable-ci-pipeline-for-every-new-service");
		const skillPath = join(dir, result.name, "SKILL.md");
		expect(existsSync(skillPath)).toBe(true);
		const markdown = readFileSync(skillPath, "utf-8");
		expect(markdown).toContain("source: learn");
		expect(markdown).toContain("trigger: /learn");
	});

	it("reports not-flagged with reasons and writes nothing when the heuristic rejects", () => {
		const dir = join(makeTempDir(), "captured");
		const result = runLearnCapture(thinTrace(), { captureDir: dir });
		expect(result.kind).toBe("not-flagged");
		if (result.kind !== "not-flagged") return;
		expect(result.score).toBeLessThan(0.55);
		expect(result.reasons.join("\n")).toContain("too thin");
		expect(existsSync(dir)).toBe(false);
	});

	it("does not capture an uncompleted task even when its score clears the threshold", () => {
		const dir = join(makeTempDir(), "captured");
		const result = runLearnCapture(highScoreButIncompleteTrace(), { captureDir: dir });
		expect(result.kind).toBe("not-flagged");
		if (result.kind !== "not-flagged") return;
		expect(result.reasons.join("\n")).toContain("not marked complete");
		expect(existsSync(dir)).toBe(false);
	});

	it("captures a heuristic-rejected task when forced", () => {
		const dir = makeTempDir();
		const result = runLearnCapture(thinTrace(), { captureDir: dir, force: true });
		expect(result.kind).toBe("captured");
		if (result.kind !== "captured") return;
		expect(existsSync(join(dir, result.name, "SKILL.md"))).toBe(true);
	});

	it("refuses to overwrite an existing skill (never clobbers hand-written work)", () => {
		const dir = makeTempDir();
		const name = "set-up-a-reusable-ci-pipeline-for-every-new-service";
		mkdirSync(join(dir, name), { recursive: true });
		writeFileSync(join(dir, name, "SKILL.md"), "---\nname: hand-written\n---\n", { encoding: "utf-8" });
		const result = runLearnCapture(reusableTrace(), { captureDir: dir });
		expect(result.kind).toBe("exists");
	});

	it("reports invalid when the capture document fails validation (empty prompt)", () => {
		const dir = makeTempDir();
		const result = runLearnCapture(
			{ prompt: "", steps: [{ summary: "a" }, { summary: "b" }], completed: true },
			{
				captureDir: dir,
				force: true,
			},
		);
		expect(result.kind).toBe("invalid");
	});

	it("uses an injected capture document when provided", () => {
		const dir = makeTempDir();
		const result = runLearnCapture(reusableTrace(), {
			captureDir: dir,
			capture: buildLearnCapture(reusableTrace(), () => new Date("2026-08-15T10:00:00.000Z")),
		});
		expect(result.kind).toBe("captured");
	});
});
