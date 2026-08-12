import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import { buildTaskTraceFromMessages, createSkillCaptureExtension } from "../../src/extensions/skill-capture/index.js";

let tempDir: string | undefined;
afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
	delete process.env.AXIOM_SKILL_CAPTURE_AUTO;
});

function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "axiom-skill-capture-ext-"));
	return tempDir;
}

/** Minimal fake ExtensionAPI that captures handlers by event and can fire them with a ctx. */
function fakePi(): { pi: ExtensionAPI; fire(event: string, payload: unknown, ctx: unknown): Promise<void> } {
	const handlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
	return {
		pi: {
			on: (evt: string, h: (...a: unknown[]) => unknown) => handlers.set(evt, [...(handlers.get(evt) ?? []), h]),
		} as unknown as ExtensionAPI,
		fire: async (event, payload, ctx) => {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
}

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const assistant = (toolNames: string[], stopReason = "stop") => ({
	role: "assistant",
	content: toolNames.map((name) => ({ type: "toolCall", id: name, name, arguments: {} })),
	stopReason,
	timestamp: 0,
});

const reusableSession = (): AgentMessage[] =>
	[
		user("Set up a reusable CI pipeline for every new service"),
		assistant(["a", "b", "c", "d", "e", "f"]),
	] as unknown as AgentMessage[];

const thinSession = (): AgentMessage[] => [user("just a one-time scratch"), assistant([])] as unknown as AgentMessage[];

function countSkills(dir: string): number {
	if (!existsSync(dir)) return 0;
	return readdirSync(dir, { withFileTypes: true }).filter(
		(e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")),
	).length;
}

describe("buildTaskTraceFromMessages", () => {
	it("extracts prompt, tool-call steps, and completion from a session", () => {
		const trace = buildTaskTraceFromMessages(reusableSession());
		expect(trace.prompt).toContain("reusable CI pipeline");
		expect(trace.steps.map((s) => s.summary)).toEqual(["a", "b", "c", "d", "e", "f"]);
		expect(trace.completed).toBe(true);
	});
	it("marks a task incomplete when the last assistant turn errored", () => {
		const messages = [user("do x"), assistant(["tool"], "error")] as unknown as AgentMessage[];
		expect(buildTaskTraceFromMessages(messages).completed).toBe(false);
	});
});

describe("createSkillCaptureExtension (agent_end)", () => {
	it("materializes + offers a skill when a reusable completed task is enabled and flagged", async () => {
		const dir = makeTempDir();
		const notifyCalls: string[] = [];
		const { pi, fire } = fakePi();
		createSkillCaptureExtension({ enabled: true, captureDir: dir })(pi);
		await fire(
			"agent_end",
			{ type: "agent_end", messages: reusableSession() },
			{ ui: { notify: (m: string) => notifyCalls.push(m) } },
		);
		expect(countSkills(dir)).toBe(1);
		expect(notifyCalls.some((m) => m.includes("Captured reusable skill"))).toBe(true);
	});

	it("is inert and writes nothing when disabled (default, env unset)", async () => {
		const dir = makeTempDir();
		const notifyCalls: string[] = [];
		const { pi, fire } = fakePi();
		createSkillCaptureExtension({ enabled: false, captureDir: dir })(pi);
		await fire(
			"agent_end",
			{ type: "agent_end", messages: reusableSession() },
			{ ui: { notify: (m: string) => notifyCalls.push(m) } },
		);
		expect(countSkills(dir)).toBe(0);
		expect(notifyCalls).toHaveLength(0);
	});

	it("does not capture a thin one-off session even when enabled", async () => {
		const dir = makeTempDir();
		const notifyCalls: string[] = [];
		const { pi, fire } = fakePi();
		createSkillCaptureExtension({ enabled: true, captureDir: dir })(pi);
		await fire(
			"agent_end",
			{ type: "agent_end", messages: thinSession() },
			{ ui: { notify: (m: string) => notifyCalls.push(m) } },
		);
		expect(countSkills(dir)).toBe(0);
		expect(notifyCalls).toHaveLength(0);
	});
});
