import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type * as PiAi from "@earendil-works/pi-ai";
import { fromAny } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import {
	consolidationAuditPath,
	consolidationPendingDir,
	listPendingProposals,
	readAuditEvents,
} from "../../src/core/memory-consolidation/index.js";
import type { ConsolidationRequest, MemoryFact } from "../../src/core/memory-consolidation/types.js";
import { loadHarnessState } from "../../src/core/refinement/index.js";
import { createMemoryConsolidationExtension } from "../../src/extensions/memory-consolidation/index.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

let tempDir: string | undefined;
afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
	delete process.env.AXIOM_MEMORY_CONSOLIDATION;
	delete process.env.AXIOM_MEMORY_CONSOLIDATION_AUTO;
	completeSimpleMock.mockReset();
});

function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "axiom-mc-ext-"));
	return tempDir;
}

function fakePi(): { pi: ExtensionAPI; fire(event: string, payload: unknown, ctx: unknown): Promise<void> } {
	const handlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
	return {
		pi: fromAny<ExtensionAPI, unknown>({
			on: (evt: string, h: (...a: unknown[]) => unknown) => handlers.set(evt, [...(handlers.get(evt) ?? []), h]),
		}),
		fire: async (event, payload, ctx) => {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
}

function shutdownEvent(overrides: Record<string, unknown> = {}) {
	return { type: "session_shutdown", reason: "quit", ...overrides };
}

function fakeCtx(overrides: Record<string, unknown> = {}) {
	const notifyCalls: string[] = [];
	const ctx = {
		model: { id: "test-model", maxTokens: 8192 },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
		},
		sessionManager: {
			getSessionId: () => "sess-1",
			getEntries: () =>
				session().map((message, index) => ({
					id: `entry-${index}`,
					parentId: null,
					timestamp: new Date(0).toISOString(),
					type: "message",
					message,
				})),
		},
		ui: { notify: (m: string) => notifyCalls.push(m) },
		signal: undefined,
		...overrides,
	};
	return { ctx, notifyCalls };
}

const session = (): AgentMessage[] =>
	fromAny<AgentMessage[], unknown>([
		{ role: "user", content: [{ type: "text", text: "session text" }], timestamp: 0 },
	]);

const facts = (): MemoryFact[] => [
	{
		title: "Sandbox known-fails",
		content: "The daemon/worker EXDEV suites are documented sandbox known-fails, never regressions.",
	},
	{ title: "Transient note", content: "We are currently mid-refactor this session and still working on it" },
];

const proposal = () => ({
	summary: "consolidated sandbox policy",
	rationale: "durable environment fact",
	facts: facts(),
});

function pendingCount(dir: string): number {
	return listPendingProposals(consolidationPendingDir(dir)).length;
}

describe("createMemoryConsolidationExtension (session_shutdown)", () => {
	it("is inert when explicitly disabled", async () => {
		const root = makeTempDir();
		const { pi, fire } = fakePi();
		const { ctx, notifyCalls } = fakeCtx();
		const plan = vi.fn();
		createMemoryConsolidationExtension({
			enabled: false,
			consolidationDir: root,
			harnessStateDir: root,
			plan,
		})(pi);
		await fire("session_shutdown", shutdownEvent(), ctx);
		expect(plan).not.toHaveBeenCalled();
		expect(notifyCalls).toHaveLength(0);
		expect(pendingCount(root)).toBe(0);
	});

	it("skips silently without a model or without API auth", async () => {
		const root = makeTempDir();
		const { pi, fire } = fakePi();
		const plan = vi.fn();
		createMemoryConsolidationExtension({ enabled: true, consolidationDir: root, harnessStateDir: root, plan })(pi);
		await fire("session_shutdown", shutdownEvent(), fakeCtx({ model: undefined }).ctx);
		expect(plan).not.toHaveBeenCalled();
		await fire(
			"agent_end",
			{ type: "agent_end", messages: session() },
			fakeCtx({ modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) } }).ctx,
		);
		expect(plan).not.toHaveBeenCalled();
	});

	it("stages only gate-accepted facts and audits the decision (propose mode)", async () => {
		const root = makeTempDir();
		const { pi, fire } = fakePi();
		const { ctx, notifyCalls } = fakeCtx();
		createMemoryConsolidationExtension({
			enabled: true,
			auto: false,
			consolidationDir: root,
			harnessStateDir: root,
			plan: async () => proposal(),
		})(pi);
		await fire("session_shutdown", shutdownEvent(), ctx);
		const pending = listPendingProposals(consolidationPendingDir(root));
		expect(pending).toHaveLength(1);
		expect(pending[0]?.facts.map((f) => f.title)).toEqual(["Sandbox known-fails"]);
		expect(pending[0]?.sessionId).toBe("sess-1");
		expect(notifyCalls.some((m) => m.includes("staged 1 durable fact"))).toBe(true);
		const events = readAuditEvents(consolidationAuditPath(root));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ action: "staged", proposed: 2, accepted: 1, sessionId: "sess-1" });
		expect(events[0]?.rejected.join(" ")).toContain("transient signal");
	});

	it("stages nothing and writes no audit when no fact survives the gate", async () => {
		const root = makeTempDir();
		const { pi, fire } = fakePi();
		const { ctx, notifyCalls } = fakeCtx();
		createMemoryConsolidationExtension({
			enabled: true,
			auto: false,
			consolidationDir: root,
			harnessStateDir: root,
			plan: async () => ({ summary: "s", rationale: "r", facts: facts().slice(1) }),
		})(pi);
		await fire("session_shutdown", shutdownEvent(), ctx);
		expect(pendingCount(root)).toBe(0);
		expect(readAuditEvents(consolidationAuditPath(root))).toHaveLength(0);
		expect(notifyCalls).toHaveLength(0);
	});

	it("applies accepted facts immediately in auto mode with an audit trail", async () => {
		const root = makeTempDir();
		const { pi, fire } = fakePi();
		const { ctx, notifyCalls } = fakeCtx();
		createMemoryConsolidationExtension({
			enabled: true,
			auto: true,
			consolidationDir: root,
			harnessStateDir: root,
			plan: async () => proposal(),
		})(pi);
		await fire("session_shutdown", shutdownEvent(), ctx);
		const state = loadHarnessState(root);
		const entries = Object.values(state.entries.memory);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.source).toBe("consolidate");
		const events = readAuditEvents(consolidationAuditPath(root));
		expect(events).toHaveLength(1);
		expect(events[0]?.action).toBe("auto_applied");
		expect(events[0]?.entryIds?.length).toBe(1);
		expect(notifyCalls.some((m) => m.includes("applied 1 durable fact"))).toBe(true);
		expect(pendingCount(root)).toBe(0);
	});

	it("audits failures and never throws", async () => {
		const root = makeTempDir();
		const { pi, fire } = fakePi();
		const { ctx, notifyCalls } = fakeCtx();
		createMemoryConsolidationExtension({
			enabled: true,
			auto: false,
			consolidationDir: root,
			harnessStateDir: root,
			plan: async () => {
				throw new Error("model exploded");
			},
		})(pi);
		await expect(fire("session_shutdown", shutdownEvent(), ctx)).resolves.toBeUndefined();
		const events = readAuditEvents(consolidationAuditPath(root));
		expect(events).toHaveLength(1);
		expect(events[0]?.action).toBe("failed");
		expect(events[0]?.error).toContain("model exploded");
		expect(pendingCount(root)).toBe(0);
		expect(notifyCalls).toHaveLength(0);
	});

	it("honors the AXIOM_MEMORY_CONSOLIDATION env flags through the real plan path", async () => {
		process.env.AXIOM_MEMORY_CONSOLIDATION = "1";
		process.env.AXIOM_MEMORY_CONSOLIDATION_AUTO = "1";
		completeSimpleMock.mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "text",
					text: '{"summary":"env-flag run","rationale":"r","facts":[{"title":"Env fact","content":"Env flags enable real consolidation end to end."}]}',
				},
			],
		});
		const root = makeTempDir();
		const { pi, fire } = fakePi();
		const { ctx, notifyCalls } = fakeCtx();
		// Only paths injected: enablement comes from the environment, and the
		// real plan → gate → apply pipeline runs against the mocked model.
		createMemoryConsolidationExtension({ consolidationDir: root, harnessStateDir: root })(pi);
		await fire("session_shutdown", shutdownEvent(), ctx);
		const state = loadHarnessState(root);
		expect(Object.values(state.entries.memory)).toHaveLength(1);
		expect(readAuditEvents(consolidationAuditPath(root))[0]?.action).toBe("auto_applied");
		expect(notifyCalls.length).toBeGreaterThan(0);
		// Auto mode applies directly: no staged proposals, only the audit log.
		expect(existsSync(consolidationAuditPath(root))).toBe(true);
		expect(listPendingProposals(consolidationPendingDir(root))).toHaveLength(0);
	});

	it("is enabled and auto-applies silently by default (no env, no deps) — ADR-0078", async () => {
		completeSimpleMock.mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "text",
					text: '{"summary":"default-run","rationale":"r","facts":[{"title":"Default fact","content":"Silent-by-default consolidation applies without asking."}]}',
				},
			],
		});
		const root = makeTempDir();
		const { pi, fire } = fakePi();
		const { ctx, notifyCalls } = fakeCtx();
		// No enabled/auto/plan deps and no env vars: the new default is on + auto.
		createMemoryConsolidationExtension({ consolidationDir: root, harnessStateDir: root })(pi);
		await fire("session_shutdown", shutdownEvent(), ctx);
		const state = loadHarnessState(root);
		expect(Object.values(state.entries.memory)).toHaveLength(1);
		expect(readAuditEvents(consolidationAuditPath(root))[0]?.action).toBe("auto_applied");
		expect(notifyCalls.some((m) => m.includes("applied 1 durable fact"))).toBe(true);
		expect(listPendingProposals(consolidationPendingDir(root))).toHaveLength(0);
	});

	it("AXIOM_MEMORY_CONSOLIDATION=0 opts out of the silent default", async () => {
		process.env.AXIOM_MEMORY_CONSOLIDATION = "0";
		const root = makeTempDir();
		const { pi, fire } = fakePi();
		const { ctx, notifyCalls } = fakeCtx();
		createMemoryConsolidationExtension({ consolidationDir: root, harnessStateDir: root })(pi);
		await fire("session_shutdown", shutdownEvent(), ctx);
		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(notifyCalls).toHaveLength(0);
		expect(pendingCount(root)).toBe(0);
		expect(existsSync(consolidationAuditPath(root))).toBe(false);
	});

	it("does not consolidate on agent_end (the per-prompt hook is not a session end)", async () => {
		const root = makeTempDir();
		const { pi, fire } = fakePi();
		const { ctx, notifyCalls } = fakeCtx();
		const plan = vi.fn();
		createMemoryConsolidationExtension({
			enabled: true,
			consolidationDir: root,
			harnessStateDir: root,
			plan,
		})(pi);
		// A resident session (interactive/daemon) ends its agent loop on every
		// prompt. Consolidating there would add an extra model call per prompt —
		// the flip to silent-by-default must never make agent_end a trigger.
		await fire("agent_end", { type: "agent_end", messages: session() }, ctx);
		expect(plan).not.toHaveBeenCalled();
		expect(notifyCalls).toHaveLength(0);
		expect(pendingCount(root)).toBe(0);
	});

	it("does not consolidate on non-quit shutdowns (reload/new/resume/fork are not session ends)", async () => {
		const root = makeTempDir();
		const { pi, fire } = fakePi();
		const { ctx, notifyCalls } = fakeCtx();
		const plan = vi.fn();
		createMemoryConsolidationExtension({
			enabled: true,
			consolidationDir: root,
			harnessStateDir: root,
			plan,
		})(pi);
		for (const reason of ["reload", "new", "resume", "fork"] as const) {
			await fire("session_shutdown", shutdownEvent({ reason }), ctx);
		}
		expect(plan).not.toHaveBeenCalled();
		expect(notifyCalls).toHaveLength(0);
		expect(pendingCount(root)).toBe(0);
	});

	it("builds the proposal request from the finished session entries", async () => {
		const root = makeTempDir();
		const { pi, fire } = fakePi();
		const { ctx } = fakeCtx();
		const received: unknown[] = [];
		createMemoryConsolidationExtension({
			enabled: true,
			auto: false,
			consolidationDir: root,
			harnessStateDir: root,
			buildRequest: (messages, options) => {
				received.push({ messages, options });
				return fromAny<ConsolidationRequest, unknown>({
					conversationText: "",
					messages,
					existingMemories: options.existingMemories,
				});
			},
			plan: async () => proposal(),
		})(pi);
		await fire("session_shutdown", shutdownEvent(), ctx);
		expect(received).toHaveLength(1);
		expect(fromAny<{ messages: AgentMessage[] }, unknown>(received[0]).messages).toEqual(session());
	});
});
