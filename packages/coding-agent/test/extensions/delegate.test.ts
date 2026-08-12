import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRpcClientBridge } from "../../src/extensions/delegate/bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import type { SessionStats } from "../../src/core/session-stats.js";
import type { RpcDelegateBridge, RpcDelegateRunResult } from "../../src/extensions/delegate/bridge.js";
import { createDelegateExtension, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "../../src/extensions/delegate/index.js";
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
	const tools: Array<{ name: string; execute?: (id: string, p: unknown) => Promise<unknown> }> = [];
	const pi = {
		registerTool: (tool: { name: string; execute: (id: string, p: unknown) => Promise<unknown> }) => {
			tools.push(tool);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, tools };
}

class StubBridge implements RpcDelegateBridge {
	started = 0;
	stopped = 0;
	runCalls: Array<{ task: string; timeoutMs: number }> = [];
	runResult: RpcDelegateRunResult | null = null;
	runError: Error | null = null;
	hang = false;

	async start(): Promise<void> {
		this.started += 1;
	}
	async runTask(task: string, timeoutMs: number): Promise<RpcDelegateRunResult> {
		this.runCalls.push({ task, timeoutMs });
		if (this.hang) {
			return new Promise<RpcDelegateRunResult>(() => undefined); // never resolves
		}
		if (this.runError) throw this.runError;
		return this.runResult ?? { lastAssistantText: "default summary", stats: stats() };
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
