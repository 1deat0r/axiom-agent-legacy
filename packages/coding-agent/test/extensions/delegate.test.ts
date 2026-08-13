import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRpcClientBridge, parseModelRef } from "../../src/extensions/delegate/bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import type { SessionStats } from "../../src/core/session-stats.js";
import type { RpcDelegateBridge, RpcDelegateRunResult } from "../../src/extensions/delegate/bridge.js";
import {
	BATCH_CONCURRENCY,
	createDelegateExtension,
	DEFAULT_TIMEOUT_MS,
	MAX_TASKS,
	MAX_TIMEOUT_MS,
} from "../../src/extensions/delegate/index.js";
import {
	capSummary,
	DEFAULT_SUMMARY_MAX_CHARS,
	emptyAccounting,
	NO_SUMMARY_TEXT,
	summaryOrFallback,
	toDelegateResult,
} from "../../src/extensions/delegate/result.js";

// ============================================================================
// Pure result-block logic
// ============================================================================

function stats(input = 40, output = 20): SessionStats {
	return {
		sessionFile: undefined,
		sessionId: "s",
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 2,
		tokens: { input: input, output: output, cacheRead: 0, cacheWrite: 0, total: input + output },
		cost: 0.0012,
	};
}

describe("capSummary", () => {
	it("returns empty for a non-positive cap", () => {
		expect(capSummary("x", 0)).toBe("");
		expect(capSummary("x", -1)).toBe("");
	});

	it("passes through text within the cap, trimmed", () => {
		expect(capSummary("  hello  ", 20)).toBe("hello");
	});

	it("truncates longer text to the cap (compactness guarantee — no transcript)", () => {
		const long = "a".repeat(5000);
		const capped = capSummary(long, 100);
		expect(capped.length).toBe(100);
	});
});

describe("summaryOrFallback / emptyAccounting", () => {
	it("falls back for null/undefined/blank closing text", () => {
		expect(summaryOrFallback(null)).toBe(NO_SUMMARY_TEXT);
		expect(summaryOrFallback(undefined)).toBe(NO_SUMMARY_TEXT);
		expect(summaryOrFallback("   ")).toBe(NO_SUMMARY_TEXT);
		expect(summaryOrFallback("done")).toBe("done");
	});

	it("yields a zeroed accounting", () => {
		expect(emptyAccounting()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	});
});

describe("toDelegateResult", () => {
	it("shapes an ok result with capped summary, recorded tokens and cost", () => {
		const r = toDelegateResult(
			{ ok: true, summary: "finished task", tokens: stats(40, 20).tokens, cost: 0.0012 },
			200,
		);
		expect(r.ok).toBe(true);
		expect(r.summary).toBe("finished task");
		expect(r.tokens.total).toBe(60);
		expect(r.tokens.input).toBe(40);
		expect(r.cost).toBe(0.0012);
		expect(r.error).toBeUndefined();
	});

	it("defaults to zero accounting when the helper recorded none", () => {
		const r = toDelegateResult({ ok: true, summary: "x" });
		expect(r.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		expect(r.cost).toBe(0);
	});

	it("shapes a failure with a trimmed, non-empty error and empty summary", () => {
		const r = toDelegateResult({ ok: false, error: "  boom  " });
		expect(r.ok).toBe(false);
		expect(r.summary).toBe("");
		expect(r.error).toBe("boom");
	});

	it("never attaches raw messages / transcripts to the result", () => {
		const r = toDelegateResult({ ok: true, summary: "hello", tokens: stats().tokens, cost: 0 });
		// The block carries only the declared fields — no messages array, no transcript.
		expect(Object.keys(r).sort()).toEqual(["cost", "ok", "summary", "tokens"]);
		expect(JSON.stringify(r)).not.toContain("assistant");
		expect(JSON.stringify(r)).not.toContain("tool_call");
	});

	it("caps the summary to summaryMaxChars", () => {
		const raw = "x".repeat(5000);
		const r = toDelegateResult({ ok: true, summary: raw }, 50);
		expect(r.summary.length).toBe(50);
	});
});

// ============================================================================
// Tool behavior (injectable stub bridge — deterministic, no process, no keys)
// ============================================================================

function fakePi() {
	const tools: Array<{
		name: string;
		execute?: (id: string, p: unknown, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
	}> = [];
	const handlers: Array<{ event: string; handler: (event: unknown) => void }> = [];
	const pi = {
		registerTool: (tool: { name: string; execute: (id: string, p: unknown) => Promise<unknown> }) => {
			tools.push(tool);
		},
		on: (event: string, handler: (event: unknown) => void) => {
			handlers.push({ event, handler });
		},
	};
	return { pi: pi as unknown as ExtensionAPI, tools, handlers };
}

async function waitUntil(cond: () => unknown, timeoutMs = 2000): Promise<void> {
	const startedAt = Date.now();
	for (;;) {
		if (cond()) {
			return;
		}
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("waitUntil timeout");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

class StubBridge implements RpcDelegateBridge {
	started = 0;
	stopped = 0;
	runCalls: Array<{ task: string; timeoutMs: number }> = [];
	runResult: RpcDelegateRunResult | null = null;
	runError: Error | null = null;
	hang = false;
	failOnTask: string | null = null;
	// Concurrency probe: when gateOn is set, runTask stays in-flight until release().
	gateOn = false;
	running = 0;
	maxRunning = 0;
	private gates: Array<() => void> = [];

	async start(): Promise<void> {
		this.started += 1;
	}
	async runTask(task: string, timeoutMs: number): Promise<RpcDelegateRunResult> {
		this.runCalls.push({ task, timeoutMs });
		this.running += 1;
		this.maxRunning = Math.max(this.maxRunning, this.running);
		if (this.gateOn) {
			await new Promise<void>((resolve) => this.gates.push(resolve));
		}
		this.running -= 1;
		if (this.hang) {
			return new Promise<RpcDelegateRunResult>(() => undefined); // never resolves
		}
		if (this.failOnTask !== null && task === this.failOnTask) {
			throw new Error("boom");
		}
		if (this.runError) throw this.runError;
		return this.runResult ?? { lastAssistantText: "default summary", stats: stats() };
	}
	release(): void {
		// Open the gate permanently so later waves (new task slots in the pool)
		// proceed instead of blocking forever.
		this.gateOn = false;
		for (const gate of this.gates.splice(0)) {
			gate();
		}
	}
	async stop(): Promise<void> {
		this.stopped += 1;
	}
}

describe("createDelegateExtension", () => {
	it("registers the delegate tool", () => {
		const { pi, tools } = fakePi();
		createDelegateExtension()(pi);
		expect(tools.some((t) => t.name === "delegate")).toBe(true);
	});

	it("rejects an empty task", async () => {
		const { pi, tools } = fakePi();
		createDelegateExtension()(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		await expect(tool.execute!("c1", { task: "   " })).rejects.toThrow("non-empty task");
	});

	it("returns a compact ok block with recorded tokens and cost", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		createDelegateExtension({ bridge: () => stub })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = (await tool.execute!("c1", { task: "tidy the repo" })) as {
			content: Array<{ type: string; text: string }>;
			details: { ok: boolean; summary: string; tokens: { total: number }; cost: number };
		};
		expect(stub.started).toBe(1);
		expect(stub.stopped).toBe(1);
		expect(out.content[0]!.text).toContain("[delegate ok]");
		expect(out.content[0]!.text).toContain("tokens");
		expect(out.details.ok).toBe(true);
		expect(out.details.tokens.total).toBe(60);
		expect(out.details.cost).toBe(0.0012);
		// The parent context gained only the compact block, not any transcript.
		expect(out.content[0]!.text.length).toBeLessThan(300);
	});

	it("returns ok:false with a bounded summary on helper error", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		stub.runError = new Error("provider refused");
		createDelegateExtension({ bridge: () => stub })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = (await tool.execute!("c1", { task: "do it" })) as {
			content: Array<{ type: string; text: string }>;
			details: { ok: boolean; error: string };
		};
		expect(out.details.ok).toBe(false);
		expect(out.details.error).toBe("provider refused");
		expect(out.content[0]!.text).toContain("[delegate failed]");
		// Still reaped exactly once.
		expect(stub.stopped).toBe(1);
	});

	it("enforces the timeout and still stops the helper exactly once (no orphan)", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		stub.hang = true;
		createDelegateExtension({ bridge: () => stub, timeoutMs: 50 })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = (await tool.execute!("c1", { task: "hang" })) as { details: { ok: boolean; error: string } };
		expect(out.details.ok).toBe(false);
		expect(out.details.error).toContain("timed out");
		expect(stub.stopped).toBe(1);
	});

	it("creates one fresh helper (bridge) per delegate call — per-call reset", async () => {
		const { pi, tools } = fakePi();
		let built = 0;
		createDelegateExtension({
			bridge: () => {
				built += 1;
				return new StubBridge();
			},
		})(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		await tool.execute!("c1", { task: "a" });
		await tool.execute!("c2", { task: "b" });
		expect(built).toBe(2);
		// Each call also started+stopped its own bridge.
	});

	it("clamps a caller-supplied timeoutMs to MAX_TIMEOUT_MS", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		createDelegateExtension({ bridge: () => stub })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		await tool.execute!("c1", { task: "t", timeoutMs: 999_999 });
		expect(stub.runCalls[0]!.timeoutMs).toBe(MAX_TIMEOUT_MS);
	});

	it("defaults the timeout to DEFAULT_TIMEOUT_MS", async () => {
		expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
		expect(DEFAULT_SUMMARY_MAX_CHARS).toBe(2000);
	});

	it("parseModelRef parses provider/model, bare model, and empty", () => {
		expect(parseModelRef("anthropic/claude-sonnet-4-5")).toEqual({
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
		expect(parseModelRef("claude-sonnet-4-5")).toEqual({ model: "claude-sonnet-4-5" });
		expect(parseModelRef(undefined)).toEqual({});
		expect(parseModelRef("   ")).toEqual({});
	});

	it("threads a requested model reference into the helper bridge", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		let seenModel: string | undefined;
		createDelegateExtension({
			bridge: (model) => {
				seenModel = model;
				return stub;
			},
		})(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		await tool.execute!("c1", { task: "t", model: "anthropic/claude-sonnet-4-5" });
		expect(seenModel).toBe("anthropic/claude-sonnet-4-5");
	});

	it("clamps non-finite and negative timeouts safely", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		createDelegateExtension({ bridge: () => stub })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		await tool.execute!("c1", { task: "t", timeoutMs: Number.NaN });
		expect(stub.runCalls[0]!.timeoutMs).toBe(DEFAULT_TIMEOUT_MS); // non-finite -> default
		await tool.execute!("c2", { task: "t", timeoutMs: Number.POSITIVE_INFINITY });
		expect(stub.runCalls[1]!.timeoutMs).toBe(DEFAULT_TIMEOUT_MS); // non-finite -> default
		await tool.execute!("c3", { task: "t", timeoutMs: -5 });
		expect(stub.runCalls[2]!.timeoutMs).toBe(1); // negatives floored to 1
	});

	it("falls back to the parent's live model via ctx when no model param is given", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		let seen: string | undefined;
		createDelegateExtension({
			bridge: (model) => {
				seen = model;
				return stub;
			},
		})(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = (await tool.execute!("c1", { task: "t" }, undefined, undefined, {
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		})) as { details: { helper: { model: string | undefined; sessionId: string | undefined } } };
		expect(seen).toBe("anthropic/claude-sonnet-4-5");
		expect(out.details.helper!.model).toBe("anthropic/claude-sonnet-4-5");
		expect(out.details.helper!.sessionId).toBe("s");
	});

	it("an empty/whitespace model param falls through to the parent's live model", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		let seen: string | undefined;
		createDelegateExtension({
			bridge: (model) => {
				seen = model;
				return stub;
			},
		})(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		await tool.execute!("c1", { task: "t", model: "   " }, undefined, undefined, {
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		});
		expect(seen).toBe("anthropic/claude-sonnet-4-5");
	});

	it("an explicit model param wins over the parent's live model", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		let seen: string | undefined;
		createDelegateExtension({
			bridge: (model) => {
				seen = model;
				return stub;
			},
		})(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		await tool.execute!("c1", { task: "t", model: "openai/gpt-4o" }, undefined, undefined, {
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		});
		expect(seen).toBe("openai/gpt-4o");
	});

	it("rejects when neither task nor tasks is supplied", async () => {
		const { pi, tools } = fakePi();
		createDelegateExtension()(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		await expect(tool.execute!("c1", {})).rejects.toThrow("non-empty task");
		await expect(tool.execute!("c1", { tasks: [] })).rejects.toThrow("non-empty task");
	});

	it("runs a batch across fresh helpers, one per task, aggregates, and reaps them all", async () => {
		const { pi, tools } = fakePi();
		const built: StubBridge[] = [];
		createDelegateExtension({
			bridge: () => {
				const stub = new StubBridge();
				built.push(stub);
				return stub;
			},
		})(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = (await tool.execute!("c1", { tasks: ["a", "b", "c"] })) as {
			content: Array<{ type: string; text: string }>;
			details: {
				ok: boolean;
				delegations: Array<{ ok: boolean; tokens: { total: number }; cost: number }>;
				tokens: { total: number };
				cost: number;
			};
		};
		expect(built).toHaveLength(3); // one fresh helper per task (per-call reset holds per delegation)
		expect(out.details.ok).toBe(true);
		expect(out.details.delegations).toHaveLength(3);
		expect(out.details.tokens.total).toBe(180); // 3 x 60
		expect(out.details.cost).toBeCloseTo(0.0036); // 3 x 0.0012
		expect(out.content[0]!.text).toContain("[delegate batch]");
		expect(out.content[0]!.text).toContain("3 tasks");
		// No orphan: every per-delegation bridge was started and stopped exactly once.
		for (const stub of built) {
			expect(stub.started).toBe(1);
			expect(stub.stopped).toBe(1);
		}
	});

	it("bounds batch concurrency to BATCH_CONCURRENCY helpers at a time", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		stub.gateOn = true;
		createDelegateExtension({ bridge: () => stub })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const tasks = Array.from({ length: 8 }, (_, i) => `t${i}`);
		const promise = tool.execute!("c1", { tasks });
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(stub.maxRunning).toBeLessThanOrEqual(BATCH_CONCURRENCY);
		expect(stub.maxRunning).toBe(BATCH_CONCURRENCY); // exactly 4 in-flight, not 8
		stub.release();
		const out = (await promise) as { details: { ok: boolean; delegations: unknown[] } };
		expect(out.details.ok).toBe(true);
		expect(out.details.delegations).toHaveLength(8);
	});

	it("rejects a batch larger than MAX_TASKS", async () => {
		const { pi, tools } = fakePi();
		createDelegateExtension()(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const tasks = Array.from({ length: MAX_TASKS + 1 }, (_, i) => `t${i}`);
		await expect(tool.execute!("c1", { tasks })).rejects.toThrow("exceeds MAX_TASKS");
	});

	it("batch keeps sibling results and reports ok:false on partial failure", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		stub.failOnTask = "b";
		createDelegateExtension({ bridge: () => stub })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = (await tool.execute!("c1", { tasks: ["a", "b"] })) as {
			details: { ok: boolean; delegations: Array<{ ok: boolean; error?: string }> };
		};
		expect(out.details.ok).toBe(false);
		expect(out.details.delegations[0]!.ok).toBe(true);
		expect(out.details.delegations[1]!.ok).toBe(false);
		expect(out.details.delegations[1]!.error).toBe("boom");
	});

	it("the default export wires real defaults", () => {
		const { pi, tools } = fakePi();
		// Default bridge wiring is exercised only by the live-gated test; here we
		// assert the factory registers the tool with real default deps.
		createDelegateExtension()(pi);
		expect(tools.some((t) => t.name === "delegate")).toBe(true);
	});
});

// ============================================================================
// Live-gated: real helper process via the genuine RPC bridge
// Mirrors rpc.test.ts; skipped in the neutral suite (./test.sh scrubs keys).
// ============================================================================

describe.skipIf(!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_OAUTH_TOKEN)("delegate real bridge", () => {
	it("spawns a helper process and returns a compact run result", async () => {
		const bridge = createRpcClientBridge({
			cliPath: join(__dirname, "..", "dist", "cli.js"),
			cwd: join(__dirname, ".."),
			env: { PI_CODING_AGENT_DIR: join(__dirname, "..", ".tmp-delegate-live") },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
		await bridge.start();
		try {
			const run = await bridge.runTask("Reply with just the word hello", 60_000);
			expect(run.lastAssistantText).toBeTruthy();
			expect(run.stats.tokens.total).toBeGreaterThan(0);
		} finally {
			await bridge.stop();
		}
	}, 90_000);
});

describe("background delegate", () => {
	function tmpResultsDir(): string {
		return mkdtempSync(join(tmpdir(), "delegate-bg-"));
	}

	it("returns immediately with a handle and result file without awaiting the helper", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		stub.gateOn = true;
		createDelegateExtension({ bridge: () => stub, resultsDir: tmpResultsDir() })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = (await tool.execute!("c1", { task: "long job", background: true })) as {
			details: { background: boolean; handle: string; resultFile: string; status: string };
		};
		expect(stub.started).toBe(1);
		expect(stub.runCalls).toHaveLength(1);
		expect(stub.stopped).toBe(0);
		expect(out.details.background).toBe(true);
		expect(out.details.handle).toBeTruthy();
		expect(out.details.resultFile).toContain("delegate-bg-");
		expect(out.details.status).toBe("running");
		stub.release();
		await waitUntil(() => stub.stopped === 1);
	});

	it("writes the compact result file when the background helper finishes", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		createDelegateExtension({ bridge: () => stub, resultsDir: tmpResultsDir() })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = (await tool.execute!("c1", { task: "job", background: true })) as {
			details: { resultFile: string };
		};
		await waitUntil(() => existsSync(out.details.resultFile));
		const payload = JSON.parse(readFileSync(out.details.resultFile, "utf8"));
		expect(payload.status).toBe("done");
		expect(payload.result.ok).toBe(true);
		expect(payload.result.summary).toBe("default summary");
		expect(stub.stopped).toBe(1);
	});

	it("collects a finished background run by handle", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		createDelegateExtension({ bridge: () => stub, resultsDir: tmpResultsDir() })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const started = (await tool.execute!("c1", { task: "job", background: true })) as {
			details: { handle: string };
		};
		await waitUntil(() => stub.stopped === 1);
		const out = (await tool.execute!("c2", { handle: started.details.handle })) as {
			content: Array<{ type: string; text: string }>;
			details: { ok: boolean; summary: string };
		};
		expect(out.details.ok).toBe(true);
		expect(out.details.summary).toBe("default summary");
		expect(out.content[0]!.text).toContain("[delegate ok]");
	});

	it("reports a still-running run via handle without blocking", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		stub.gateOn = true;
		createDelegateExtension({ bridge: () => stub, resultsDir: tmpResultsDir() })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const started = (await tool.execute!("c1", { task: "long", background: true })) as {
			details: { handle: string };
		};
		const out = (await tool.execute!("c2", { handle: started.details.handle })) as {
			details: { status: string };
		};
		expect(out.details.status).toBe("running");
		stub.release();
		await waitUntil(() => stub.stopped === 1);
	});

	it("waits up to waitMs when collecting a running run", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		stub.gateOn = true;
		createDelegateExtension({ bridge: () => stub, resultsDir: tmpResultsDir() })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const started = (await tool.execute!("c1", { task: "long", background: true })) as {
			details: { handle: string };
		};
		setTimeout(() => stub.release(), 20);
		const out = (await tool.execute!("c2", { handle: started.details.handle, waitMs: 1000 })) as {
			details: { ok: boolean };
		};
		expect(out.details.ok).toBe(true);
	});

	it("times out a background helper and writes an ok:false file (no orphan)", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		stub.hang = true;
		createDelegateExtension({ bridge: () => stub, timeoutMs: 50, resultsDir: tmpResultsDir() })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const started = (await tool.execute!("c1", { task: "hang", background: true })) as {
			details: { resultFile: string };
		};
		await waitUntil(() => existsSync(started.details.resultFile));
		const payload = JSON.parse(readFileSync(started.details.resultFile, "utf8"));
		expect(payload.status).toBe("timeout");
		expect(payload.result.ok).toBe(false);
		expect(payload.result.error).toContain("timed out");
		expect(stub.stopped).toBe(1);
	});

	it("rejects an unknown handle", async () => {
		const { pi, tools } = fakePi();
		createDelegateExtension({ resultsDir: tmpResultsDir() })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		await expect(tool.execute!("c1", { handle: "nope" })).rejects.toThrow("unknown delegate handle");
	});

	it("fans out a background batch into per-task handles", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		createDelegateExtension({ bridge: () => stub, resultsDir: tmpResultsDir() })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = (await tool.execute!("c1", { tasks: ["a", "b"], background: true })) as {
			details: { background: boolean; handles: string[]; resultFiles: string[] };
		};
		expect(out.details.background).toBe(true);
		expect(out.details.handles).toHaveLength(2);
		expect(out.details.resultFiles).toHaveLength(2);
		await waitUntil(() => stub.stopped === 2);
	});

	it("stops background helpers on session_shutdown", async () => {
		const { pi, tools, handlers } = fakePi();
		const stub = new StubBridge();
		stub.gateOn = true;
		createDelegateExtension({ bridge: () => stub, resultsDir: tmpResultsDir() })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		await tool.execute!("c1", { task: "long", background: true });
		expect(stub.stopped).toBe(0);
		const shutdown = handlers.find((h) => h.event === "session_shutdown");
		expect(shutdown).toBeDefined();
		shutdown!.handler({ type: "session_shutdown", reason: "quit" });
		await waitUntil(() => stub.stopped === 1);
	});
});
