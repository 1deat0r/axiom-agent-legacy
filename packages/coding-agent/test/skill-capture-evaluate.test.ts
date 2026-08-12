import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	handleSkillCaptureAutoCommand,
	parseSkillCaptureAutoArgs,
	readTraceFile,
} from "../src/cli/skill-capture-auto-command.js";
import type { TaskTrace } from "../src/core/skill-capture/index.js";
import { CAPTURE_THRESHOLD, evaluateTaskForCapture } from "../src/core/skill-capture/index.js";

let tempDir: string | undefined;
afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});
function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "skill-capture-auto-test-"));
	return tempDir;
}

function trace(prompt: string, nSteps: number, overrides: Partial<TaskTrace> = {}): TaskTrace {
	return {
		prompt,
		steps: Array.from({ length: nSteps }, (_, i) => ({ summary: `step ${i + 1}` })),
		completed: true,
		...overrides,
	};
}

describe("evaluateTaskForCapture", () => {
	it("flags a complex, completed, reusable task", () => {
		const evaluation = evaluateTaskForCapture(trace("How to set up CI every time, reusable pattern", 6));
		expect(evaluation.shouldCapture).toBe(true);
		expect(evaluation.score).toBeGreaterThanOrEqual(CAPTURE_THRESHOLD);
	});

	it("does not flag a thin one-off task", () => {
		const evaluation = evaluateTaskForCapture(trace("Just a one-time throwaway", 1));
		expect(evaluation.shouldCapture).toBe(false);
	});

	it("does not flag an incomplete multi-step task", () => {
		const evaluation = evaluateTaskForCapture(trace("Deploy the service routinely", 4, { completed: false }));
		expect(evaluation.shouldCapture).toBe(false);
	});

	it("pins the neutral boundary: completed multi-step without signals is reusable; thin without signals is not", () => {
		expect(evaluateTaskForCapture(trace("Do the bake", 6)).shouldCapture).toBe(true);
		expect(evaluateTaskForCapture(trace("Do the bake", 2)).shouldCapture).toBe(false);
	});

	it("flags a two-step completed task when a reusable signal is present", () => {
		expect(evaluateTaskForCapture(trace("A pattern we will reuse", 2)).shouldCapture).toBe(true);
	});
});

describe("parseSkillCaptureAutoArgs", () => {
	it("parses the happy path", () => {
		const parsed = parseSkillCaptureAutoArgs(["skill-capture-auto", "trace.json", "--out", "/tmp/out", "--force"]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.options.traceFile).toBe("trace.json");
		expect(parsed.options.out).toBe("/tmp/out");
		expect(parsed.options.force).toBe(true);
	});

	it("requires trace file and --out", () => {
		const parsed = parseSkillCaptureAutoArgs(["skill-capture-auto", "--out", "/tmp/out"]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.errors.join(" ")).toContain("trace.json");
	});
});

describe("readTraceFile", () => {
	it("reads a trace and normalizes string steps", () => {
		const dir = makeTempDir();
		const file = join(dir, "trace.json");
		writeFileSync(
			file,
			JSON.stringify({ prompt: "p", steps: ["a", { summary: "b", detail: "d" }], sessionId: "s1" }),
			"utf-8",
		);
		const result = readTraceFile(file);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.trace.steps).toEqual([{ summary: "a" }, { summary: "b", detail: "d" }]);
		expect(result.file.sessionId).toBe("s1");
	});
});

describe("handleSkillCaptureAutoCommand", () => {
	it("captures when the task is flagged reusable", () => {
		const dir = makeTempDir();
		const logs: string[] = [];
		const errs: string[] = [];
		const traceFile = join(dir, "t.json");
		writeFileSync(
			traceFile,
			JSON.stringify({
				prompt: "Routine deploy, reusable pattern",
				steps: Array.from({ length: 6 }, (_, i) => `step ${i + 1}`),
			}),
			"utf-8",
		);
		const handled = handleSkillCaptureAutoCommand(["skill-capture-auto", traceFile, "--out", dir], {
			log: (m) => logs.push(m),
			err: (m) => errs.push(m),
		});
		expect(handled).toBe(true);
		expect(errs).toEqual([]);
		expect(logs.join("\n")).toContain("Flagged reusable");
		expect(logs.join("\n")).toContain("captured skill");
		// a skill dir was created
		expect(existsSync(join(dir, "routine-deploy-reusable-pattern", "SKILL.md"))).toBe(true);
	});

	it("does not capture when the task is not flagged (and --force overrides)", () => {
		const dir = makeTempDir();
		const logs: string[] = [];
		const errs: string[] = [];
		const traceFile = join(dir, "t.json");
		writeFileSync(traceFile, JSON.stringify({ prompt: "one-time scratch", steps: ["did it"] }), "utf-8");
		const handled = handleSkillCaptureAutoCommand(["skill-capture-auto", traceFile, "--out", dir], {
			log: (m) => logs.push(m),
			err: (m) => errs.push(m),
		});
		expect(handled).toBe(true);
		expect(logs.join("\n")).toContain("not flagged");
		expect(errs).toEqual([]);

		// --force captures regardless
		const logs2: string[] = [];
		handleSkillCaptureAutoCommand(["skill-capture-auto", traceFile, "--out", dir, "--force"], {
			log: (m) => logs2.push(m),
			err: (m) => errs.push(m),
		});
		expect(logs2.join("\n")).toContain("Flagged reusable");
	});

	it("returns false for non skill-capture-auto commands", () => {
		const handled = handleSkillCaptureAutoCommand(["skill-capture", "--help"], { log: () => {}, err: () => {} });
		expect(handled).toBe(false);
	});
});
