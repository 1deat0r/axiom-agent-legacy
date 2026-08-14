import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createRpcClientBridge,
	HELPER_ENV_SCRUB_KEYS,
	parseModelRef,
	scrubHelperEnv,
} from "../../src/extensions/delegate/bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { fromAny } from "@total-typescript/shoehorn";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import type { SessionStats } from "../../src/core/session-stats.js";
import type { RpcDelegateBridge, RpcDelegateRunResult } from "../../src/extensions/delegate/bridge.js";
import {
	buildHelperPrompt,
	capHandoff,
	DEFAULT_HANDOFF_CAPS,
	type DelegateHandoffCaps,
	parseDelegateHandoff,
} from "../../src/extensions/delegate/handoff.js";
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
	renderBatchResult,
	renderDelegateResult,
	summaryOrFallback,
	toBatchResult,
	toDelegateResult,
} from "../../src/extensions/delegate/result.js";
import type { DelegateHandoff } from "../../src/extensions/delegate/types.js";

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
	return { pi: fromAny<ExtensionAPI, unknown>(pi), tools, handlers };
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
		const out = fromAny<
			{
				content: Array<{ type: string; text: string }>;
				details: { ok: boolean; summary: string; tokens: { total: number }; cost: number };
			},
			unknown
		>(await tool.execute!("c1", { task: "tidy the repo" }));
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
		const out = fromAny<
			{
				content: Array<{ type: string; text: string }>;
				details: { ok: boolean; error: string };
			},
			unknown
		>(await tool.execute!("c1", { task: "do it" }));
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
		const out = fromAny<{ details: { ok: boolean; error: string } }, unknown>(
			await tool.execute!("c1", { task: "hang" }),
		);
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
		const out = fromAny<
			{ details: { helper: { model: string | undefined; sessionId: string | undefined } } },
			unknown
		>(
			await tool.execute!("c1", { task: "t" }, undefined, undefined, {
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			}),
		);
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
		const out = fromAny<
			{
				content: Array<{ type: string; text: string }>;
				details: {
					ok: boolean;
					delegations: Array<{ ok: boolean; tokens: { total: number }; cost: number }>;
					tokens: { total: number };
					cost: number;
				};
			},
			unknown
		>(await tool.execute!("c1", { tasks: ["a", "b", "c"] }));
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
		const out = fromAny<{ details: { ok: boolean; delegations: unknown[] } }, unknown>(await promise);
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
		const out = fromAny<
			{
				details: { ok: boolean; delegations: Array<{ ok: boolean; error?: string }> };
			},
			unknown
		>(await tool.execute!("c1", { tasks: ["a", "b"] }));
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

// ============================================================================
// Helper env scrub (issue #26): a helper spawned from an RLM-harness session
// must never inherit the harness variables. The bridge owns the scrub;
// RpcClient drops undefined env entries at spawn.
// ============================================================================

describe("helper env scrub", () => {
	const ambientHarnessEnv = {
		PATH: "/usr/bin",
		AXIOM_HOME: "/home/u/.axiom",
		RLM_DEPTH: "1",
		RLM_MAX_DEPTH: "2",
		RLM_SESSION_DIR: "/fake/session",
		RLM_GLOBAL_HARNESS_STATE_DIR: "/fake/global",
		RLM_HARNESS_STATE_DIR: "/fake/harness",
		AXIOM_CODING_AGENT_DIR: "/fake/agent-dir",
	};

	it("marks the harness variables unset and keeps every other entry", () => {
		const scrubbed = scrubHelperEnv(ambientHarnessEnv);
		expect(scrubbed.PATH).toBe("/usr/bin");
		expect(scrubbed.AXIOM_HOME).toBe("/home/u/.axiom");
		for (const key of HELPER_ENV_SCRUB_KEYS) {
			expect(scrubbed[key]).toBeUndefined();
		}
	});

	it("lets explicit extra entries win over the ambient scrub (escape hatch)", () => {
		const scrubbed = scrubHelperEnv(
			{ RLM_DEPTH: "1", AXIOM_CODING_AGENT_DIR: "/ambient" },
			{ AXIOM_CODING_AGENT_DIR: "/explicit", PROBE_KEEP: "yes" },
		);
		expect(scrubbed.RLM_DEPTH).toBeUndefined();
		expect(scrubbed.AXIOM_CODING_AGENT_DIR).toBe("/explicit");
		expect(scrubbed.PROBE_KEEP).toBe("yes");
	});

	it("matches the RLM_* set ./test.sh unsets, plus AXIOM_CODING_AGENT_DIR", () => {
		const testShPath = join(__dirname, "..", "..", "..", "..", "test.sh");
		const testSh = readFileSync(testShPath, "utf8");
		const unsetRlm = new Set<string>();
		for (const line of testSh.split("\n")) {
			const match = line.match(/^\s*unset\s+(.+)$/);
			if (!match) {
				continue;
			}
			for (const name of match[1].split(/\s+/)) {
				if (name.startsWith("RLM_")) {
					unsetRlm.add(name);
				}
			}
		}
		const rlmScrub = HELPER_ENV_SCRUB_KEYS.filter((key) => key.startsWith("RLM_"));
		expect([...unsetRlm].sort()).toEqual([...rlmScrub].sort());
		expect(HELPER_ENV_SCRUB_KEYS).toContain("AXIOM_CODING_AGENT_DIR");
	});

	it("spawns a helper that never sees ambient harness variables but sees explicit extras", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delegate-env-"));
		const probePath = join(dir, "probe.mjs");
		const outPath = join(dir, "env.json");
		writeFileSync(
			probePath,
			[
				'import { writeFileSync } from "node:fs";',
				"writeFileSync(process.env.PROBE_OUT, JSON.stringify({",
				"  rlm: 'RLM_DEPTH' in process.env,",
				"  codingDir: 'AXIOM_CODING_AGENT_DIR' in process.env,",
				"  keep: process.env.PROBE_KEEP ?? null,",
				"}));",
				"setInterval(() => {}, 60000);",
			].join("\n"),
		);

		const prevRlm = process.env.RLM_DEPTH;
		const prevCodingDir = process.env.AXIOM_CODING_AGENT_DIR;
		process.env.RLM_DEPTH = "/fake/harness";
		process.env.AXIOM_CODING_AGENT_DIR = "/fake/agent-dir";

		const bridge = createRpcClientBridge({
			cliPath: probePath,
			env: { PROBE_OUT: outPath, PROBE_KEEP: "yes" },
		});
		try {
			await bridge.start();
			const deadline = Date.now() + 10_000;
			while (!existsSync(outPath) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(existsSync(outPath)).toBe(true);
			const seen = fromAny<{ rlm: boolean; codingDir: boolean; keep: string | null }, unknown>(
				JSON.parse(readFileSync(outPath, "utf8")),
			);
			expect(seen.rlm).toBe(false);
			expect(seen.codingDir).toBe(false);
			expect(seen.keep).toBe("yes");
		} finally {
			await bridge.stop();
			if (prevRlm === undefined) {
				delete process.env.RLM_DEPTH;
			} else {
				process.env.RLM_DEPTH = prevRlm;
			}
			if (prevCodingDir === undefined) {
				delete process.env.AXIOM_CODING_AGENT_DIR;
			} else {
				process.env.AXIOM_CODING_AGENT_DIR = prevCodingDir;
			}
		}
	}, 30_000);
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
		const out = fromAny<
			{
				details: { background: boolean; handle: string; resultFile: string; status: string };
			},
			unknown
		>(await tool.execute!("c1", { task: "long job", background: true }));
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
		const out = fromAny<
			{
				details: { resultFile: string };
			},
			unknown
		>(await tool.execute!("c1", { task: "job", background: true }));
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
		const started = fromAny<
			{
				details: { handle: string };
			},
			unknown
		>(await tool.execute!("c1", { task: "job", background: true }));
		await waitUntil(() => stub.stopped === 1);
		const out = fromAny<
			{
				content: Array<{ type: string; text: string }>;
				details: { ok: boolean; summary: string };
			},
			unknown
		>(await tool.execute!("c2", { handle: started.details.handle }));
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
		const started = fromAny<
			{
				details: { handle: string };
			},
			unknown
		>(await tool.execute!("c1", { task: "long", background: true }));
		const out = fromAny<
			{
				details: { status: string };
			},
			unknown
		>(await tool.execute!("c2", { handle: started.details.handle }));
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
		const started = fromAny<
			{
				details: { handle: string };
			},
			unknown
		>(await tool.execute!("c1", { task: "long", background: true }));
		setTimeout(() => stub.release(), 20);
		const out = fromAny<
			{
				details: { ok: boolean };
			},
			unknown
		>(await tool.execute!("c2", { handle: started.details.handle, waitMs: 1000 }));
		expect(out.details.ok).toBe(true);
	});

	it("times out a background helper and writes an ok:false file (no orphan)", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		stub.hang = true;
		createDelegateExtension({ bridge: () => stub, timeoutMs: 50, resultsDir: tmpResultsDir() })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const started = fromAny<
			{
				details: { resultFile: string };
			},
			unknown
		>(await tool.execute!("c1", { task: "hang", background: true }));
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
		const out = fromAny<
			{
				details: { background: boolean; handles: string[]; resultFiles: string[] };
			},
			unknown
		>(await tool.execute!("c1", { tasks: ["a", "b"], background: true }));
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

// ============================================================================
// Ralph handoff (issue #33): the helper ends its run with a bounded structured
// report — status, summary, evidence, next steps, blockers — parsed into
// DelegateResult.handoff. The old compact result stays the fallback.
// ============================================================================

function handoffJson(overrides: Record<string, unknown> = {}): string {
	const base = {
		status: "done",
		summary: "ported the capability",
		evidence: ["12 tests green", "tsgo clean"],
		nextSteps: ["merge the branch"],
		blockers: [],
	};
	return JSON.stringify({ ...base, ...overrides });
}

function fullHandoff(): DelegateHandoff {
	return {
		status: "done",
		summary: "ported the capability",
		evidence: ["12 tests green", "tsgo clean"],
		nextSteps: ["merge the branch"],
		blockers: [],
	};
}

describe("buildHelperPrompt", () => {
	it("keeps the task and asks the helper for the five handoff fields as JSON", () => {
		const prompt = buildHelperPrompt("tidy the repo");
		expect(prompt).toContain("tidy the repo");
		for (const field of ["status", "summary", "evidence", "nextSteps", "blockers"]) {
			expect(prompt).toContain(field);
		}
		expect(prompt.toLowerCase()).toContain("json");
	});
});

describe("parseDelegateHandoff", () => {
	it("parses a bare JSON handoff with all five fields", () => {
		expect(parseDelegateHandoff(handoffJson())).toEqual(fullHandoff());
	});

	it("parses a fenced json block inside prose", () => {
		const text = `finished the job.\n\`\`\`json\n${handoffJson()}\n\`\`\``;
		const parsed = parseDelegateHandoff(text);
		expect(parsed?.status).toBe("done");
		expect(parsed?.evidence).toEqual(["12 tests green", "tsgo clean"]);
	});

	it("parses a handoff wrapped in prose (brace slicing)", () => {
		const parsed = parseDelegateHandoff(`Here is my report. ${handoffJson()} Thanks.`);
		expect(parsed?.summary).toBe("ported the capability");
		expect(parsed?.blockers).toEqual([]);
	});

	it("accepts snake_case next_steps", () => {
		const text = JSON.stringify({
			status: "blocked",
			summary: "s",
			evidence: [],
			next_steps: ["unblock"],
			blockers: [],
		});
		expect(parseDelegateHandoff(text)?.nextSteps).toEqual(["unblock"]);
	});

	it("wraps single-string evidence/nextSteps/blockers into arrays", () => {
		const text = JSON.stringify({
			status: "done",
			summary: "s",
			evidence: "e1",
			nextSteps: "n1",
			blockers: "b1",
		});
		const parsed = parseDelegateHandoff(text)!;
		expect(parsed.evidence).toEqual(["e1"]);
		expect(parsed.nextSteps).toEqual(["n1"]);
		expect(parsed.blockers).toEqual(["b1"]);
	});

	it("returns undefined when the text holds no JSON object", () => {
		expect(parseDelegateHandoff("all done, nothing to see")).toBeUndefined();
		expect(parseDelegateHandoff(null)).toBeUndefined();
		expect(parseDelegateHandoff(undefined)).toBeUndefined();
		expect(parseDelegateHandoff("   ")).toBeUndefined();
	});

	it("returns undefined for a JSON object without any handoff field", () => {
		expect(parseDelegateHandoff(JSON.stringify({ other: 1 }))).toBeUndefined();
	});
});

describe("capHandoff", () => {
	const tinyCaps: DelegateHandoffCaps = {
		statusMaxChars: 4,
		summaryMaxChars: 10,
		evidenceMaxItems: 2,
		evidenceItemMaxChars: 6,
		nextStepsMaxItems: 1,
		nextStepItemMaxChars: 5,
		blockersMaxItems: 2,
		blockerItemMaxChars: 4,
	};

	it("caps every field to its limit", () => {
		const capped = capHandoff(
			{
				status: "completed-status",
				summary: "a very long summary string",
				evidence: ["evidence item one", "evidence item two", "evidence item three"],
				nextSteps: ["step one", "step two"],
				blockers: ["big blocker"],
			},
			tinyCaps,
		);
		expect(capped.status).toBe("comp");
		expect(capped.summary).toBe("a very lon");
		expect(capped.evidence).toEqual(["eviden", "eviden"]);
		expect(capped.nextSteps).toEqual(["step "]);
		expect(capped.blockers).toEqual(["big "]);
	});

	it("drops blank items and trims strings", () => {
		const capped = capHandoff(
			{
				status: "  done  ",
				summary: " s ",
				evidence: ["", "  ", "kept"],
				nextSteps: [],
				blockers: [],
			},
			DEFAULT_HANDOFF_CAPS,
		);
		expect(capped.status).toBe("done");
		expect(capped.summary).toBe("s");
		expect(capped.evidence).toEqual(["kept"]);
	});

	it("keeps the default summary cap aligned with the compact result cap", () => {
		expect(DEFAULT_HANDOFF_CAPS.summaryMaxChars).toBe(DEFAULT_SUMMARY_MAX_CHARS);
	});
});

describe("toDelegateResult handoff", () => {
	it("attaches a handoff to an ok result", () => {
		const r = toDelegateResult({ ok: true, summary: "raw text", handoff: fullHandoff() });
		expect(r.handoff).toEqual(fullHandoff());
	});

	it("caps the handoff at the result boundary", () => {
		const r = toDelegateResult(
			{
				ok: true,
				summary: "x",
				handoff: {
					status: "x".repeat(500),
					summary: "s",
					evidence: [],
					nextSteps: [],
					blockers: [],
				},
			},
			200,
		);
		expect(r.handoff!.status.length).toBe(DEFAULT_HANDOFF_CAPS.statusMaxChars);
	});

	it("renders the structured handoff in the parent-facing text", () => {
		const result = toDelegateResult({
			ok: true,
			summary: "raw",
			handoff: {
				status: "blocked",
				summary: "stuck",
				evidence: ["e1"],
				nextSteps: ["n1"],
				blockers: ["b1"],
			},
			tokens: stats().tokens,
			cost: 0,
		});
		const rendered = renderDelegateResult(result);
		expect(rendered).toContain("[delegate ok]");
		expect(rendered).toContain("stuck");
		expect(rendered).toContain("Evidence: e1");
		expect(rendered).toContain("Next: n1");
		expect(rendered).toContain("Blockers: b1");
	});

	it("never attaches a handoff to a failure", () => {
		const r = toDelegateResult({
			ok: false,
			error: "boom",
			handoff: fullHandoff(),
		});
		expect(r.handoff).toBeUndefined();
		expect(r.error).toBe("boom");
	});
});

describe("delegate tool handoff wiring", () => {
	it("attaches the parsed handoff when the helper ends with the JSON handoff", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		stub.runResult = { lastAssistantText: `Done. ${handoffJson()}`, stats: stats() };
		createDelegateExtension({ bridge: () => stub })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = fromAny<
			{
				content: Array<{ type: string; text: string }>;
				details: { ok: boolean; summary: string; handoff?: DelegateHandoff };
			},
			unknown
		>(await tool.execute!("c1", { task: "port it" }));
		expect(out.details.handoff).toBeDefined();
		expect(out.details.handoff!.status).toBe("done");
		expect(out.details.handoff!.evidence).toEqual(["12 tests green", "tsgo clean"]);
		// The old compact summary still carries the raw closing text.
		expect(out.details.summary).toContain("Done.");
		// The parent-facing text renders the structured handoff.
		expect(out.content[0]!.text).toContain("[delegate ok]");
		expect(out.content[0]!.text).toContain("ported the capability");
		expect(out.content[0]!.text).toContain("Next: merge the branch");
	});

	it("keeps the old compact result when the helper emits no handoff", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		createDelegateExtension({ bridge: () => stub })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = fromAny<
			{
				content: Array<{ type: string; text: string }>;
				details: { ok: boolean; summary: string; handoff?: DelegateHandoff };
			},
			unknown
		>(await tool.execute!("c1", { task: "tidy the repo" }));
		expect(out.details.ok).toBe(true);
		expect(out.details.handoff).toBeUndefined();
		expect(out.content[0]!.text).toBe("[delegate ok] 60 tokens, $0.0012\ndefault summary");
	});

	it("aggregates handoffs in input order for a batch", async () => {
		const { pi, tools } = fakePi();
		const byTask = new Map<string, string>([
			["first", handoffJson({ status: "done", summary: "one" })],
			["second", handoffJson({ status: "blocked", summary: "two", blockers: ["z"] })],
		]);
		class PerTaskBridge extends StubBridge {
			constructor(private readonly texts: Map<string, string>) {
				super();
			}
			override async runTask(task: string, timeoutMs: number): Promise<RpcDelegateRunResult> {
				await super.runTask(task, timeoutMs);
				return { lastAssistantText: this.texts.get(task) ?? "default summary", stats: stats() };
			}
		}
		createDelegateExtension({ bridge: () => new PerTaskBridge(byTask) })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = fromAny<
			{
				content: Array<{ type: string; text: string }>;
				details: { delegations: Array<{ ok: boolean; handoff?: DelegateHandoff }> };
			},
			unknown
		>(await tool.execute!("c1", { tasks: ["first", "second"] }));
		expect(out.details.delegations[0]!.handoff?.status).toBe("done");
		expect(out.details.delegations[0]!.handoff?.summary).toBe("one");
		expect(out.details.delegations[1]!.handoff?.status).toBe("blocked");
		expect(out.details.delegations[1]!.handoff?.summary).toBe("two");
		// Rendered in order, status-labeled.
		const rendered = out.content[0]!.text;
		const oneIdx = rendered.indexOf("one");
		const twoIdx = rendered.indexOf("two");
		expect(oneIdx).toBeGreaterThan(-1);
		expect(twoIdx).toBeGreaterThan(oneIdx);
		expect(rendered).toContain("[blocked]");
	});

	it("writes the handoff into the background result file", async () => {
		const { pi, tools } = fakePi();
		const stub = new StubBridge();
		stub.runResult = { lastAssistantText: handoffJson(), stats: stats() };
		createDelegateExtension({ bridge: () => stub, resultsDir: mkdtempSync(join(tmpdir(), "delegate-bg-")) })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = fromAny<{ details: { resultFile: string } }, unknown>(
			await tool.execute!("c1", { task: "job", background: true }),
		);
		await waitUntil(() => existsSync(out.details.resultFile));
		const payload = JSON.parse(readFileSync(out.details.resultFile, "utf8"));
		expect(payload.result.handoff.status).toBe("done");
		expect(payload.result.handoff.evidence).toEqual(["12 tests green", "tsgo clean"]);
		expect(stub.stopped).toBe(1);
	});
});

describe("renderBatchResult handoff order", () => {
	it("renders per-delegation handoffs in input order with their status", () => {
		const batch = toBatchResult([
			toDelegateResult({
				ok: true,
				summary: "s1",
				handoff: { status: "done", summary: "first", evidence: [], nextSteps: [], blockers: [] },
			}),
			toDelegateResult({
				ok: true,
				summary: "s2",
				handoff: {
					status: "blocked",
					summary: "second",
					evidence: [],
					nextSteps: [],
					blockers: ["x"],
				},
			}),
		]);
		const rendered = renderBatchResult(batch);
		const firstIdx = rendered.indexOf("first");
		const secondIdx = rendered.indexOf("second");
		expect(firstIdx).toBeGreaterThan(-1);
		expect(secondIdx).toBeGreaterThan(firstIdx);
		expect(rendered).toContain("[done]");
		expect(rendered).toContain("[blocked]");
	});
});

describe("delegate helper prompt (real bridge)", () => {
	it("sends the handoff-requesting prompt to the helper process", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delegate-prompt-"));
		const probePath = join(dir, "probe.mjs");
		const outPath = join(dir, "prompt.json");
		writeFileSync(
			probePath,
			[
				'import { createInterface } from "node:readline";',
				'import { writeFileSync } from "node:fs";',
				"const rl = createInterface({ input: process.stdin });",
				'const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");',
				'rl.on("line", (line) => {',
				"  let cmd;",
				"  try { cmd = JSON.parse(line); } catch { return; }",
				'  if (cmd.type === "prompt") {',
				"    writeFileSync(process.env.PROBE_OUT, JSON.stringify({ message: cmd.message }));",
				'    out({ id: cmd.id, type: "response", command: "prompt", success: true });',
				'    out({ type: "agent_end" });',
				'  } else if (cmd.type === "get_last_assistant_text") {',
				'    out({ id: cmd.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: "probe" } });',
				'  } else if (cmd.type === "get_session_stats") {',
				'    out({ id: cmd.id, type: "response", command: "get_session_stats", success: true, data: { sessionFile: null, sessionId: "probe", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 } });',
				"  }",
				"});",
				"setInterval(() => {}, 60000);",
			].join("\n"),
		);
		const bridge = createRpcClientBridge({ cliPath: probePath, env: { PROBE_OUT: outPath } });
		try {
			await bridge.start();
			const run = await bridge.runTask("tidy the repo", 10_000);
			expect(run.lastAssistantText).toBe("probe");
			const deadline = Date.now() + 5000;
			while (!existsSync(outPath) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(existsSync(outPath)).toBe(true);
			const seen = fromAny<{ message: string }, unknown>(JSON.parse(readFileSync(outPath, "utf8")));
			expect(seen.message).toBe(buildHelperPrompt("tidy the repo"));
			expect(seen.message).toContain("blockers");
			expect(seen.message).toContain("tidy the repo");
		} finally {
			await bridge.stop();
		}
	}, 30_000);
});
