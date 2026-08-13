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
import type { MemoryFact } from "../../src/core/memory-consolidation/types.js";
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

function fakeCtx(overrides: Record<string, unknown> = {}) {
	const notifyCalls: string[] = [];
	const ctx = {
		model: { id: "test-model", maxTokens: 8192 },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
		},
		sessionManager: { getSessionId: () => "sess-1" },
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

describe("createMemoryConsolidationExtension (agent_end)", () => {
	it("is inert when disabled (default, env unset)", async () => {
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
		await fire("agent_end", { type: "agent_end", messages: session() }, ctx);
		expect(plan).not.toHaveBeenCalled();
		expect(notifyCalls).toHaveLength(0);
		expect(pendingCount(root)).toBe(0);
	});

	it("skips silently without a model or without API auth", async () => {
		const root = makeTempDir();
		const { pi, fire } = fakePi();
		const plan = vi.fn();
		createMemoryConsolidationExtension({ enabled: true, consolidationDir: root, harnessStateDir: root, plan })(pi);
		await fire("agent_end", { type: "agent_end", messages: session() }, fakeCtx({ model: undefined }).ctx);
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
			consolidationDir: root,
			harnessStateDir: root,
			plan: async () => proposal(),
		})(pi);
		await fire("agent_end", { type: "agent_end", messages: session() }, ctx);
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
			consolidationDir: root,
			harnessStateDir: root,
			plan: async () => ({ summary: "s", rationale: "r", facts: facts().slice(1) }),
		})(pi);
		await fire("agent_end", { type: "agent_end", messages: session() }, ctx);
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
		await fire("agent_end", { type: "agent_end", messages: session() }, ctx);
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
			consolidationDir: root,
			harnessStateDir: root,
			plan: async () => {
				throw new Error("model exploded");
			},
		})(pi);
		await expect(fire("agent_end", { type: "agent_end", messages: session() }, ctx)).resolves.toBeUndefined();
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
		await fire("agent_end", { type: "agent_end", messages: session() }, ctx);
		const state = loadHarnessState(root);
		expect(Object.values(state.entries.memory)).toHaveLength(1);
		expect(readAuditEvents(consolidationAuditPath(root))[0]?.action).toBe("auto_applied");
		expect(notifyCalls.length).toBeGreaterThan(0);
		// Auto mode applies directly: no staged proposals, only the audit log.
		expect(existsSync(consolidationAuditPath(root))).toBe(true);
		expect(listPendingProposals(consolidationPendingDir(root))).toHaveLength(0);
	});
});
