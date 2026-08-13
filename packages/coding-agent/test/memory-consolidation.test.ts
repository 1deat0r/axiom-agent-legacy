import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type * as PiAi from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appendAuditEvent,
	applyMemoryFacts,
	buildConsolidationRequest,
	consolidationAuditPath,
	consolidationPendingDir,
	evaluateMemoryFacts,
	listPendingProposals,
	loadPendingProposal,
	newProposalId,
	parseConsolidationResponse,
	planMemoryConsolidation,
	readAuditEvents,
	resolvePendingProposal,
	serializeSessionForConsolidation,
	stagePendingProposal,
} from "../src/core/memory-consolidation/index.js";
import type { MemoryFact } from "../src/core/memory-consolidation/types.js";
import { loadGlobalRefinementHistory, loadHarnessState } from "../src/core/refinement/index.js";

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
	completeSimpleMock.mockReset();
});

function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "axiom-mc-"));
	return tempDir;
}

function createModel(): Model<"openai-completions"> {
	return {
		id: "openai/gpt-5.5",
		name: "GPT 5.5",
		api: "openai-completions",
		provider: "prime-inference",
		baseUrl: "https://inference.primeintellect.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistantText = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	timestamp: 0,
});

const session = (): AgentMessage[] =>
	fromAny<AgentMessage[], unknown>([
		user("what is the sandbox known-fail policy?"),
		assistantText("the EXDEV suites are documented sandbox known-fails"),
	]);

const durableFact = (): MemoryFact => ({
	title: "Sandbox known-fails",
	content: "The daemon/worker EXDEV suites are documented sandbox known-fails, never regressions.",
});

describe("serializeSessionForConsolidation / buildConsolidationRequest", () => {
	it("serializes user and assistant content into bounded text", () => {
		const text = serializeSessionForConsolidation(session());
		expect(text).toContain("sandbox known-fail policy");
		expect(text).toContain("documented sandbox known-fails");
	});

	it("keeps the newest tail when the session exceeds the budget", () => {
		const text = serializeSessionForConsolidation(session(), 60);
		expect(text.length).toBeLessThanOrEqual(60);
		expect(text).toContain("documented sandbox known-fails");
		expect(text).not.toContain("sandbox known-fail policy");
	});

	it("carries existing memories and the session id into the request", () => {
		const request = buildConsolidationRequest(session(), {
			sessionId: "sess-1",
			existingMemories: [{ id: "m1", title: "Existing", content: "already known" }],
		});
		expect(request.sessionId).toBe("sess-1");
		expect(request.existingMemories).toHaveLength(1);
		expect(request.conversationText).toContain("sandbox known-fail");
	});
});

describe("evaluateMemoryFacts (durability gate)", () => {
	it("accepts a well-formed durable fact", () => {
		const result = evaluateMemoryFacts([durableFact()]);
		expect(result.accepted).toHaveLength(1);
		expect(result.rejected).toHaveLength(0);
	});

	it("rejects thin, short, and over-long facts with reasons", () => {
		const facts: MemoryFact[] = [
			{ title: "x", content: "short content that is long enough" },
			{ title: "ok title", content: "thin" },
			{ title: "a".repeat(200), content: "long enough content body here" },
			{ title: "ok title", content: "c".repeat(600) },
		];
		const result = evaluateMemoryFacts(facts);
		expect(result.accepted).toHaveLength(0);
		expect(result.rejected.map((r) => r.reasons.join(" | "))).toEqual([
			expect.stringContaining("title too short"),
			expect.stringContaining("content too thin"),
			expect.stringContaining("title too long"),
			expect.stringContaining("content too long"),
		]);
	});

	it("rejects transient session-scoped phrasing with the matching signal", () => {
		const result = evaluateMemoryFacts([
			{ title: "Current state", content: "We are currently mid-way through the refactor this session" },
		]);
		expect(result.rejected[0]?.reasons.join(" ")).toContain("transient signal");
	});

	it("does not treat 'todos' as the 'todo' signal (word boundaries)", () => {
		const result = evaluateMemoryFacts([
			{ title: "Convention", content: "The repo tracks todos in the issue tracker instead of code comments" },
		]);
		expect(result.accepted).toHaveLength(1);
	});

	it("dedupes against existing harness memory by content and by title", () => {
		const existing = [
			{ id: "m1", title: "Sandbox known-fails", content: "different wording entirely" },
			{
				id: "m2",
				title: "Other title",
				content: "the daemon/worker exdev suites are documented sandbox known-fails, never regressions.",
			},
		];
		const result = evaluateMemoryFacts([durableFact()], { existing });
		expect(result.accepted).toHaveLength(0);
		expect(result.rejected[0]?.reasons.join(" ")).toContain("m1");
	});

	it("dedupes within the proposal (first occurrence wins)", () => {
		const result = evaluateMemoryFacts([durableFact(), durableFact()]);
		expect(result.accepted).toHaveLength(1);
		expect(result.rejected[0]?.reasons.join(" ")).toContain("earlier fact");
	});

	it("does not match against empty existing content", () => {
		const result = evaluateMemoryFacts([durableFact()], {
			existing: [{ id: "m1", title: "", content: "" }],
		});
		expect(result.accepted).toHaveLength(1);
	});

	it("trims fact text and preserves the path", () => {
		const result = evaluateMemoryFacts([
			{
				title: "  Padded title  ",
				content: "   padded content body that is long enough to pass   ",
				path: "project/x",
			},
		]);
		expect(result.accepted[0]?.title).toBe("Padded title");
		expect(result.accepted[0]?.content.startsWith("padded content")).toBe(true);
		expect(result.accepted[0]?.path).toBe("project/x");
	});
});

describe("pending proposal store + audit log", () => {
	it("stages, lists, and loads a proposal with a stable id", () => {
		const dir = makeTempDir();
		const pendingDir = consolidationPendingDir(dir);
		const staged = stagePendingProposal(
			pendingDir,
			{ summary: "s", rationale: "r", facts: [durableFact()] },
			{ sessionId: "sess-1" },
		);
		expect(staged.id).toMatch(/^mc_\d+$/);
		expect(listPendingProposals(pendingDir)).toHaveLength(1);
		const loaded = loadPendingProposal(pendingDir, staged.id);
		expect(loaded?.facts[0]?.title).toBe("Sandbox known-fails");
		expect(loaded?.sessionId).toBe("sess-1");
	});

	it("gives colliding ids a suffix instead of overwriting", () => {
		const dir = makeTempDir();
		const pendingDir = consolidationPendingDir(dir);
		const now = new Date("2026-08-13T10:00:00.000Z");
		const first = stagePendingProposal(pendingDir, { summary: "a", rationale: "", facts: [] }, { now });
		const second = stagePendingProposal(pendingDir, { summary: "b", rationale: "", facts: [] }, { now });
		expect(second.id).not.toBe(first.id);
		expect(listPendingProposals(pendingDir)).toHaveLength(2);
	});

	it("skips malformed pending files when listing", () => {
		const dir = makeTempDir();
		const pendingDir = consolidationPendingDir(dir);
		stagePendingProposal(pendingDir, { summary: "s", rationale: "", facts: [durableFact()] });
		writeFileSync(join(pendingDir, "broken.json"), "{not json", "utf8");
		expect(listPendingProposals(pendingDir)).toHaveLength(1);
	});

	it("resolves (removes) a pending proposal and returns it", () => {
		const dir = makeTempDir();
		const pendingDir = consolidationPendingDir(dir);
		const staged = stagePendingProposal(pendingDir, { summary: "s", rationale: "", facts: [durableFact()] });
		const resolved = resolvePendingProposal(pendingDir, staged.id);
		expect(resolved?.id).toBe(staged.id);
		expect(listPendingProposals(pendingDir)).toHaveLength(0);
		expect(resolvePendingProposal(pendingDir, staged.id)).toBeUndefined();
	});

	it("rejects path-traversal ids without touching the filesystem", () => {
		const dir = makeTempDir();
		const pendingDir = consolidationPendingDir(dir);
		expect(loadPendingProposal(pendingDir, "../../etc/passwd")).toBeUndefined();
		expect(resolvePendingProposal(pendingDir, "mc_1/../mc_1")).toBeUndefined();
	});

	it("appends and reads audit events newest-first with a limit", () => {
		const dir = makeTempDir();
		const auditPath = consolidationAuditPath(dir);
		appendAuditEvent(auditPath, {
			id: "e1",
			action: "staged",
			proposed: 2,
			accepted: 1,
			rejected: [],
			createdAt: "2026-08-13T10:00:00.000Z",
		});
		appendAuditEvent(auditPath, {
			id: "e2",
			action: "approved",
			proposed: 1,
			accepted: 1,
			rejected: [],
			createdAt: "2026-08-13T10:01:00.000Z",
		});
		const events = readAuditEvents(auditPath, 1);
		expect(events).toHaveLength(1);
		expect(events[0]?.id).toBe("e2");
	});

	it("tolerates malformed audit lines and a missing file", () => {
		const dir = makeTempDir();
		const auditPath = consolidationAuditPath(dir);
		expect(readAuditEvents(auditPath)).toEqual([]);
		appendAuditEvent(auditPath, {
			id: "e1",
			action: "staged",
			proposed: 0,
			accepted: 0,
			rejected: [],
			createdAt: "x",
		});
		appendFileSyncEntry(auditPath, "{broken");
		expect(readAuditEvents(auditPath)).toHaveLength(1);
	});
});

function appendFileSyncEntry(path: string, line: string): void {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	writeFileSync(path, `${line}\n`, { flag: "a" });
}

describe("parseConsolidationResponse", () => {
	it("parses a fenced JSON reply into a proposal", () => {
		const proposal = parseConsolidationResponse(
			'```json\n{"summary":"s","rationale":"r","facts":[{"title":"t","content":"c","path":"p"}]}\n```',
		);
		expect(proposal.summary).toBe("s");
		expect(proposal.facts).toEqual([{ title: "t", content: "c", path: "p" }]);
	});

	it("recovers JSON wrapped in prose and tolerates missing fields", () => {
		const proposal = parseConsolidationResponse(
			'Here you go: {"facts":[{"title":"t","content":"c"},{"content":"no title"}]}',
		);
		expect(proposal.summary).toBe("Consolidated memory");
		expect(proposal.facts).toHaveLength(2);
		expect(proposal.facts[0]?.path).toBeUndefined();
	});

	it("throws when facts is not an array", () => {
		expect(() => parseConsolidationResponse('{"facts":"nope"}')).toThrow("facts must be an array");
	});

	it("throws when the reply is truncated mid-object", () => {
		expect(() => parseConsolidationResponse('{"summary":"s","facts":[{"title":"t"')).toThrow(
			/model stopped before completing/i,
		);
	});
});

describe("planMemoryConsolidation (model pass)", () => {
	it("sends the session + existing memories and parses the reply", async () => {
		completeSimpleMock.mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "text",
					text: '{"summary":"s","rationale":"r","facts":[{"title":"t","content":"durable content body here"}]}',
				},
			],
		});
		const proposal = await planMemoryConsolidation(
			{
				conversationText: "the session text",
				existingMemories: [{ id: "m1", title: "Existing", content: "already known" }],
			},
			createModel(),
			"key",
		);
		expect(proposal.facts).toHaveLength(1);
		const call = fromPartial<unknown[]>(completeSimpleMock.mock.calls[0]);
		const context = fromAny<{ systemPrompt: string; messages: { content: { text: string }[] }[] }, unknown>(call[1]);
		const promptText = context.messages.map((m) => m.content.map((c) => c.text).join("")).join("\n");
		expect(promptText).toContain("the session text");
		expect(promptText).toContain("[m1] Existing: already known");
		expect(call[2]).toMatchObject({ apiKey: "key", maxTokens: 8192 });
	});

	it("surfaces model errors and length-stops as thrown errors", async () => {
		completeSimpleMock.mockResolvedValue({ stopReason: "error", errorMessage: "boom", content: [] });
		await expect(
			planMemoryConsolidation({ conversationText: "x", existingMemories: [] }, createModel(), "key"),
		).rejects.toThrow("boom");
		completeSimpleMock.mockResolvedValue({ stopReason: "length", content: [] });
		await expect(
			planMemoryConsolidation({ conversationText: "x", existingMemories: [] }, createModel(), "key"),
		).rejects.toThrow("stopped before completing");
	});
});

describe("applyMemoryFacts (harness write path)", () => {
	it("applies accepted facts as global harness memory with consolidation provenance", () => {
		const dir = makeTempDir();
		const result = applyMemoryFacts({
			facts: [durableFact()],
			harnessStateDir: dir,
			proposalId: "mc_123",
			sessionId: "sess-1",
		});
		expect(result.acceptedCount).toBe(1);
		const state = loadHarnessState(dir);
		const entries = Object.values(state.entries.memory);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			title: "Sandbox known-fails",
			source: "consolidate",
			scope: "global",
			path: "general",
		});
		expect(entries[0]?.metadata).toMatchObject({
			source: "memory-consolidation",
			proposalId: "mc_123",
			sessionId: "sess-1",
		});
	});

	it("skips facts that duplicate memory added since staging (re-gate vs current state)", () => {
		const dir = makeTempDir();
		applyMemoryFacts({ facts: [durableFact()], harnessStateDir: dir });
		const second = applyMemoryFacts({
			facts: [durableFact(), { title: "New fact", content: "A genuinely new durable fact for future sessions." }],
			harnessStateDir: dir,
		});
		expect(second.acceptedCount).toBe(1);
		expect(second.skipped).toHaveLength(1);
		expect(second.skipped[0]?.reasons.join(" ")).toContain("existing harness memory");
	});

	it("writes nothing when no fact survives the gate", () => {
		const dir = makeTempDir();
		const result = applyMemoryFacts({
			facts: [
				{
					title: "dup",
					content: "the daemon/worker exdev suites are documented sandbox known-fails, never regressions.",
				},
			],
			harnessStateDir: dir,
			loadState: () => {
				const state = loadHarnessState(dir);
				state.entries.memory.dup = {
					id: "dup",
					kind: "memory",
					title: "Other title",
					content: "the daemon/worker exdev suites are documented sandbox known-fails, never regressions.",
					path: "general",
					scope: "global",
					reference: {},
					arguments: {},
					metadata: {},
					source: "refine",
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					version: 1,
				};
				return state;
			},
		});
		expect(result.result).toBeUndefined();
		expect(result.acceptedCount).toBe(0);
		expect(existsSync(join(dir, "harness_state.json"))).toBe(false);
	});

	it("records the apply in the global refinement history (rollback surface)", () => {
		const dir = makeTempDir();
		applyMemoryFacts({ facts: [durableFact()], harnessStateDir: dir });
		const history = loadGlobalRefinementHistory(dir);
		expect(history).toHaveLength(1);
		expect(history[0]?.appliedEdits[0]?.applied).toBe(true);
	});
});

describe("newProposalId", () => {
	it("produces stable time-ordered mc_ ids", () => {
		const id = newProposalId(new Date("2026-08-13T10:00:00.000Z"));
		expect(id).toBe("mc_20260813100000000");
	});
});
