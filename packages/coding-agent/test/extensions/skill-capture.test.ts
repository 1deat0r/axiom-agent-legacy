import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fromAny } from "@total-typescript/shoehorn";
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
		pi: fromAny<ExtensionAPI, unknown>({
			on: (evt: string, h: (...a: unknown[]) => unknown) => handlers.set(evt, [...(handlers.get(evt) ?? []), h]),
			registerCommand: () => {},
		}),
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
	fromAny<AgentMessage[], unknown>([
		user("Set up a reusable CI pipeline for every new service"),
		assistant(["a", "b", "c", "d", "e", "f"]),
	]);

const thinSession = (): AgentMessage[] =>
	fromAny<AgentMessage[], unknown>([user("just a one-time scratch"), assistant([])]);

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
		const messages = fromAny<AgentMessage[], unknown>([user("do x"), assistant(["tool"], "error")]);
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

describe("createSkillCaptureExtension (/learn command)", () => {
	/** fakePi + a command registry so /learn's registered handler can be driven. */
	function commandPi(): {
		pi: ExtensionAPI;
		fire(event: string, payload: unknown, ctx: unknown): Promise<void>;
		command(name: string): ((args: string, ctx: unknown) => Promise<void>) | undefined;
	} {
		const handlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
		const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		return {
			pi: fromAny<ExtensionAPI, unknown>({
				on: (evt: string, h: (...a: unknown[]) => unknown) => handlers.set(evt, [...(handlers.get(evt) ?? []), h]),
				registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
					commands.set(name, options.handler),
			}),
			fire: async (event, payload, ctx) => {
				for (const handler of handlers.get(event) ?? []) {
					await handler(payload, ctx);
				}
			},
			command: (name) => commands.get(name),
		};
	}

	/** A ctx shaped like ExtensionCommandContext, with a session branch to learn from. */
	function learnCtx(messages: AgentMessage[], sessionId = "sess-1"): { ctx: unknown; notify: string[] } {
		const notify: string[] = [];
		const entries = messages.map((message, index) => ({
			type: "message",
			id: `entry-${index}`,
			parentId: index === 0 ? null : `entry-${index - 1}`,
			timestamp: "2026-08-15T00:00:00.000Z",
			message,
		}));
		return {
			notify,
			ctx: fromAny<unknown, unknown>({
				ui: { notify: (message: string) => notify.push(message) },
				sessionManager: {
					getBranch: () => entries,
					getLeafId: () => "leaf",
					getSessionId: () => sessionId,
				},
			}),
		};
	}

	it("registers /learn even when the unattended hook is disabled (on-demand surface)", () => {
		const dir = makeTempDir();
		const { pi, command } = commandPi();
		createSkillCaptureExtension({ enabled: false, captureDir: dir })(pi);
		expect(command("learn")).toBeDefined();
	});

	it("captures the current session's branch as a verified, provenance-bearing skill on /learn", async () => {
		const dir = makeTempDir();
		const { pi, command } = commandPi();
		createSkillCaptureExtension({ enabled: false, captureDir: dir })(pi);
		const { ctx, notify } = learnCtx(reusableSession());
		await command("learn")?.("", ctx);
		expect(countSkills(dir)).toBe(1);
		expect(notify.some((m) => m.includes("Captured reusable skill"))).toBe(true);
		expect(notify.some((m) => m.includes("0 loader diagnostics"))).toBe(true);
	});

	it("/learn --force captures a session the heuristic would reject", async () => {
		const dir = makeTempDir();
		const { pi, command } = commandPi();
		createSkillCaptureExtension({ enabled: false, captureDir: dir })(pi);
		const { ctx, notify } = learnCtx(thinSession());
		await command("learn")?.("--force", ctx);
		expect(countSkills(dir)).toBe(1);
		expect(notify.some((m) => m.includes("Captured reusable skill"))).toBe(true);
	});

	it("reports the heuristic reasons and writes nothing when the session is not flagged", async () => {
		const dir = makeTempDir();
		const { pi, command } = commandPi();
		createSkillCaptureExtension({ enabled: false, captureDir: dir })(pi);
		const { ctx, notify } = learnCtx(thinSession());
		await command("learn")?.("", ctx);
		expect(countSkills(dir)).toBe(0);
		expect(notify.some((m) => m.includes("Not captured"))).toBe(true);
		expect(notify.some((m) => m.includes("--force"))).toBe(true);
	});

	it("refuses to overwrite an existing skill and says so", async () => {
		const dir = makeTempDir();
		const { pi, command } = commandPi();
		createSkillCaptureExtension({ enabled: false, captureDir: dir })(pi);
		mkdirSync(join(dir, "set-up-a-reusable-ci-pipeline-for-every-new-service"), { recursive: true });
		writeFileSync(
			join(dir, "set-up-a-reusable-ci-pipeline-for-every-new-service", "SKILL.md"),
			"---\nname: hand-written\n---\n",
			{ encoding: "utf-8" },
		);
		const { ctx, notify } = learnCtx(reusableSession());
		await command("learn")?.("", ctx);
		expect(countSkills(dir)).toBe(1);
		expect(notify.some((m) => m.includes("Refusing to overwrite"))).toBe(true);
	});

	it("rejects unknown arguments with the usage line and writes nothing", async () => {
		const dir = makeTempDir();
		const { pi, command } = commandPi();
		createSkillCaptureExtension({ enabled: false, captureDir: dir })(pi);
		const { ctx, notify } = learnCtx(reusableSession());
		await command("learn")?.("--name foo", ctx);
		expect(countSkills(dir)).toBe(0);
		expect(notify.some((m) => m.includes("Usage: /learn [--force]"))).toBe(true);
	});

	it("carries the session id through provenance", async () => {
		const dir = makeTempDir();
		const { pi, command } = commandPi();
		createSkillCaptureExtension({ enabled: false, captureDir: dir })(pi);
		const { ctx } = learnCtx(reusableSession(), "sess-777");
		await command("learn")?.("", ctx);
		const skill = readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => join(dir, e.name, "SKILL.md"))
			.map((p) => readFileSync(p, "utf-8"));
		expect(skill.join("\n")).toContain("sessionId: sess-777");
		expect(skill.join("\n")).toContain("source: learn");
	});
});
