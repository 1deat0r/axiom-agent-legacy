import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fromAny } from "@total-typescript/shoehorn";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.js";
import { createSkillCaptureExtension } from "../../src/extensions/skill-capture/index.js";
import { createHarness, type Harness } from "./harness.js";

let tempDir: string | undefined;
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function ui(notify: (message: string, type?: string) => void): ExtensionUIContext {
	return fromAny<ExtensionUIContext, unknown>({
		notify,
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
	});
}

/** A no-op tool the harness can actually execute, so the tool-call turn succeeds. */
const probeTool: AgentTool = {
	name: "probe",
	label: "probe",
	description: "No-op test tool for /learn suites.",
	parameters: Type.Object({ note: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

/** A completed, multi-step, reusable-signal turn the heuristic flags. */
function reusableToolTurn(): AssistantMessage {
	const base = fauxAssistantMessage("working");
	return {
		...base,
		content: [
			fauxToolCall("probe", { note: "a" }),
			fauxToolCall("probe", { note: "b" }),
			fauxToolCall("probe", { note: "c" }),
		],
		stopReason: "toolUse",
	};
}

describe("/learn session command", () => {
	it("captures the live session's branch end to end when the user types /learn", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "axiom-learn-suite-"));
		const captureDir = join(tempDir, "captured");
		const notifications: string[] = [];
		const harness = await createHarness({
			extensionFactories: [createSkillCaptureExtension({ enabled: false, captureDir })],
			tools: [probeTool],
		});
		harnesses.push(harness);
		harness.session.bindExtensions({ uiContext: ui((message) => notifications.push(message)) });

		harness.setResponses([reusableToolTurn(), fauxAssistantMessage("done")]);
		await harness.session.prompt("Set up a reusable CI pipeline for every new service");
		await harness.session.prompt("/learn");

		expect(notifications.some((message) => message.includes("Captured reusable skill"))).toBe(true);
		expect(notifications.some((message) => message.includes("0 loader diagnostics"))).toBe(true);
		const skillPath = join(captureDir, "set-up-a-reusable-ci-pipeline-for-every-new-service", "SKILL.md");
		expect(existsSync(skillPath)).toBe(true);
		expect(readFileSync(skillPath, "utf-8")).toContain("source: learn");
	});

	it("leaves the session alone and reports reasons when /learn finds nothing reusable", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "axiom-learn-suite-"));
		const captureDir = join(tempDir, "captured");
		const notifications: string[] = [];
		const harness = await createHarness({
			extensionFactories: [createSkillCaptureExtension({ enabled: false, captureDir })],
		});
		harnesses.push(harness);
		harness.session.bindExtensions({ uiContext: ui((message) => notifications.push(message)) });

		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("just a one-time scratch thing");
		await harness.session.prompt("/learn");

		expect(notifications.some((message) => message.includes("Not captured"))).toBe(true);
		expect(existsSync(captureDir)).toBe(false);
	});
});
