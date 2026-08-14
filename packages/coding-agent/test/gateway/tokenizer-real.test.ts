/**
 * Real-tokenizer evals for the session token meter (ADR-0060): the meter
 * resolves a tokenizer per provider/model family and counts real tokens
 * instead of the fixed-density heuristic (ADR-0055). The reference numbers
 * are hardcoded values verified against OpenAI's official tiktoken
 * encodings (cl100k_base and o200k_base) on 2026-08-15, so the eval grades
 * the tokenizer against an independent source instead of trusting
 * gpt-tokenizer to grade itself.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode as encodeCl100k } from "gpt-tokenizer/encoding/cl100k_base";
import { encode as encodeO200k } from "gpt-tokenizer/encoding/o200k_base";
import { describe, expect, it, vi } from "vitest";
import { InMemoryActiveModelStore } from "../../src/gateway/active-model.js";
import { MemoryChannelIndex } from "../../src/gateway/channel-index.js";
import { fakeCompletionRunner } from "../../src/gateway/completion.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { GATEWAY_SESSION_BUDGET_BYTES, sessionFilePath } from "../../src/gateway/session-reset.js";
import {
	BLOCK_OVERHEAD,
	CHARS_PER_TOKEN,
	estimateTextTokens,
	GATEWAY_SESSION_TOKEN_BUDGET,
	measureSessionTokens,
	ROLE_OVERHEAD,
	sessionExceedsTokenBudget,
} from "../../src/gateway/session-token-meter.js";
import type { TextTokenizer } from "../../src/gateway/tokenizer-registry.js";
import { resolveTokenizer } from "../../src/gateway/tokenizer-registry.js";
import type { GatewayMessage, GatewayRecipient, GatewayTransport } from "../../src/gateway/types.js";

/** Reference strings and their official tiktoken counts (see file header). */
const REFERENCE = [
	{ label: "english prose", text: "The quick brown fox jumps over the lazy dog.", cl100k: 10, o200k: 10 },
	{ label: "cjk and emoji", text: "Hello, 世界! 🚀 token counting", cl100k: 12, o200k: 8 },
	{
		label: "typescript code",
		text: "function fib(n: number): number { return n <= 1 ? n : fib(n-1) + fib(n-2); }",
		cl100k: 28,
		o200k: 28,
	},
	{ label: "diacritics", text: "Für Elise — naïveté", cl100k: 7, o200k: 6 },
];

const UNICODE_TEXT = "Hello, 世界! 🚀 token counting";
const UNICODE_CL100K = 12;
const UNICODE_O200K = 8;
const PROSE_TEXT = "The quick brown fox jumps over the lazy dog.";
const CODE_TEXT = "function fib(n: number): number { return n <= 1 ? n : fib(n-1) + fib(n-2); }";

/** A scratch home directory under the system temp dir. */
async function home(prefix: string) {
	return mkdtemp(join(tmpdir(), prefix));
}

/** A session JSONL built from a session header plus the given raw lines. */
function sessionJsonl(lines: string[]): string {
	return `${['{"type":"session","version":3,"id":"tok-real","timestamp":"2026-08-15T00:00:00.000Z"}', ...lines].join("\n")}\n`;
}

/** One message entry with a single text block. */
function textMessageEntry(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-15T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	});
}

/** Write a one-message session and return its path. */
function writeSingleTextSession(dir: string, text: string): string {
	const path = join(dir, "s.jsonl");
	writeFileSync(path, sessionJsonl([textMessageEntry("m1", text)]), "utf8");
	return path;
}

describe("gpt-tokenizer matches the official tiktoken references (ADR-0060)", () => {
	for (const ref of REFERENCE) {
		it(`encodes ${ref.label} to the official counts on both vocabularies`, () => {
			expect(encodeCl100k(ref.text)).toHaveLength(ref.cl100k);
			expect(encodeO200k(ref.text)).toHaveLength(ref.o200k);
		});
	}
});

describe("tokenizer registry resolution (ADR-0060)", () => {
	it("resolves openai gpt-4o-family models to the o200k_base tokenizer", () => {
		for (const model of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-nano", "gpt-5", "o1", "o3-mini", "o4-mini"]) {
			const resolution = resolveTokenizer("openai", model);
			expect(resolution.tokenizer.name).toBe("gpt-tokenizer/o200k_base");
			expect(resolution.warning).toBeUndefined();
		}
		expect(resolveTokenizer("openai", "gpt-4o").tokenizer.countText(UNICODE_TEXT)).toBe(UNICODE_O200K);
	});

	it("resolves openai classic models to the cl100k_base tokenizer", () => {
		for (const model of ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo", "text-embedding-ada-002"]) {
			const resolution = resolveTokenizer("openai", model);
			expect(resolution.tokenizer.name).toBe("gpt-tokenizer/cl100k_base");
			expect(resolution.warning).toBeUndefined();
		}
		expect(resolveTokenizer("openai", "gpt-4").tokenizer.countText(UNICODE_TEXT)).toBe(UNICODE_CL100K);
	});

	it("treats openai-codex and azure-openai-responses as the openai family", () => {
		expect(resolveTokenizer("openai-codex", "gpt-5").tokenizer.name).toBe("gpt-tokenizer/o200k_base");
		expect(resolveTokenizer("azure-openai-responses", "gpt-4o").tokenizer.name).toBe("gpt-tokenizer/o200k_base");
		expect(resolveTokenizer("azure-openai-responses", "gpt-4").tokenizer.name).toBe("gpt-tokenizer/cl100k_base");
	});

	it("defaults a model-less openai resolution to the o200k_base tokenizer", () => {
		expect(resolveTokenizer("openai").tokenizer.name).toBe("gpt-tokenizer/o200k_base");
		expect(resolveTokenizer("openai", "gpt-7-future").tokenizer.name).toBe("gpt-tokenizer/cl100k_base");
	});

	it("resolves every deepseek model to the cl100k_base approximation", () => {
		for (const model of [
			"deepseek-chat",
			"deepseek-reasoner",
			"deepseek-v3.2",
			"deepseek-v4-flash",
			"deepseek-v4-pro",
		]) {
			const resolution = resolveTokenizer("deepseek", model);
			expect(resolution.tokenizer.name).toBe("gpt-tokenizer/cl100k_base");
			expect(resolution.warning).toBeUndefined();
		}
		expect(resolveTokenizer("deepseek", "deepseek-v4-pro").tokenizer.countText(UNICODE_TEXT)).toBe(UNICODE_CL100K);
		expect(resolveTokenizer("deepseek").tokenizer.name).toBe("gpt-tokenizer/cl100k_base");
	});

	it("normalizes provider and model casing and whitespace", () => {
		expect(resolveTokenizer(" DeepSeek ", "DeepSeek-V4-Flash").tokenizer.name).toBe("gpt-tokenizer/cl100k_base");
		expect(resolveTokenizer("OpenAI", "GPT-4O").tokenizer.name).toBe("gpt-tokenizer/o200k_base");
	});

	it("falls back to the heuristic with a warning for an unregistered provider", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const resolution = resolveTokenizer("gemini", "gemini-3-pro");
			expect(resolution.tokenizer.name).toBe("heuristic");
			expect(resolution.tokenizer.countText(UNICODE_TEXT)).toBe(estimateTextTokens(UNICODE_TEXT));
			expect(resolution.warning).toContain("gemini");
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("warns only once per unregistered provider per process", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			resolveTokenizer("cohere", "command-r");
			resolveTokenizer("cohere", "command-a");
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("uses the heuristic silently when no provider is known", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const resolution = resolveTokenizer(undefined, undefined);
			expect(resolution.tokenizer.name).toBe("heuristic");
			expect(resolution.warning).toBeUndefined();
			expect(warn).not.toHaveBeenCalled();
			const empty = resolveTokenizer("", "gpt-4o");
			expect(empty.tokenizer.name).toBe("heuristic");
			expect(empty.warning).toBeUndefined();
		} finally {
			warn.mockRestore();
		}
	});
});

describe("session meter with a real tokenizer (ADR-0060)", () => {
	it("counts deepseek text with the cl100k_base reference instead of the density", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-tok-real-"));
		try {
			const path = writeSingleTextSession(dir, UNICODE_TEXT);
			const snapshot = measureSessionTokens(path, { provider: "deepseek", model: "deepseek-v4-flash" });
			expect(snapshot.estimator).toBe("gpt-tokenizer/cl100k_base");
			expect(snapshot.charsPerToken).toBeUndefined();
			expect(snapshot.fallbackWarning).toBeUndefined();
			expect(snapshot.surfaceTokens).toBe(UNICODE_CL100K + BLOCK_OVERHEAD + ROLE_OVERHEAD);
			expect(snapshot.pricedMessages).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("counts openai gpt-4o text with the o200k_base reference instead of the density", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-tok-real-"));
		try {
			const path = writeSingleTextSession(dir, UNICODE_TEXT);
			const snapshot = measureSessionTokens(path, { provider: "openai", model: "gpt-4o" });
			expect(snapshot.estimator).toBe("gpt-tokenizer/o200k_base");
			expect(snapshot.surfaceTokens).toBe(UNICODE_O200K + BLOCK_OVERHEAD + ROLE_OVERHEAD);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prices toolCall and toolResult blocks with the resolved tokenizer", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-tok-real-"));
		try {
			const path = join(dir, "s.jsonl");
			const argsJson = JSON.stringify({ command: "echo hi" });
			const lines = [
				JSON.stringify({
					type: "message",
					id: "c1",
					parentId: null,
					timestamp: "2026-08-15T00:00:01.000Z",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } }],
					},
				}),
				JSON.stringify({
					type: "message",
					id: "r1",
					parentId: null,
					timestamp: "2026-08-15T00:00:02.000Z",
					message: {
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "bash",
						content: [{ type: "text", text: "output text" }],
					},
				}),
			];
			writeFileSync(path, sessionJsonl(lines), "utf8");
			const snapshot = measureSessionTokens(path, { provider: "deepseek", model: "deepseek-chat" });
			const expected =
				BLOCK_OVERHEAD +
				encodeCl100k("bash").length +
				encodeCl100k(argsJson).length +
				ROLE_OVERHEAD +
				ROLE_OVERHEAD +
				BLOCK_OVERHEAD +
				encodeCl100k("bash").length +
				BLOCK_OVERHEAD +
				encodeCl100k("output text").length;
			expect(snapshot.surfaceTokens).toBe(expected);
			expect(snapshot.pricedMessages).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records the fallback warning in the snapshot for an unregistered provider", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-tok-real-"));
		try {
			const path = writeSingleTextSession(dir, UNICODE_TEXT);
			const snapshot = measureSessionTokens(path, { provider: "mistral", model: "mistral-large" });
			expect(snapshot.estimator).toBe("heuristic");
			expect(snapshot.charsPerToken).toBe(CHARS_PER_TOKEN);
			expect(snapshot.fallbackWarning).toContain("mistral");
			expect(snapshot.surfaceTokens).toBe(measureSessionTokens(path).surfaceTokens);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prefers an explicit tokenizer override over provider resolution", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-tok-real-"));
		try {
			const path = writeSingleTextSession(dir, UNICODE_TEXT);
			const fixed: TextTokenizer = { name: "heuristic", countText: () => 7 };
			const snapshot = measureSessionTokens(path, {
				provider: "deepseek",
				model: "deepseek-chat",
				tokenizer: fixed,
			});
			expect(snapshot.estimator).toBe("heuristic");
			expect(snapshot.surfaceTokens).toBe(7 + BLOCK_OVERHEAD + ROLE_OVERHEAD);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sessionExceedsTokenBudget threads the resolved tokenizer through", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-tok-real-"));
		try {
			const path = writeSingleTextSession(dir, UNICODE_TEXT);
			// Heuristic: ceil(27/4) + 8 = 15. cl100k: 12 + 8 = 20.
			expect(sessionExceedsTokenBudget(path, 19)).toBe(false);
			expect(sessionExceedsTokenBudget(path, 19, { provider: "deepseek", model: "deepseek-chat" })).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("comparison: real tokenizer vs the fixed-density estimator (ADR-0060)", () => {
	it("counts a code-heavy transcript higher than the density heuristic", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-tok-cmp-"));
		try {
			const path = join(dir, "s.jsonl");
			const lines = [
				JSON.stringify({
					type: "message",
					id: "c1",
					parentId: null,
					timestamp: "2026-08-15T00:00:01.000Z",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call_1", name: "edit", arguments: { source: CODE_TEXT } }],
					},
				}),
			];
			writeFileSync(path, sessionJsonl(lines), "utf8");
			const heuristic = measureSessionTokens(path);
			const real = measureSessionTokens(path, { provider: "deepseek", model: "deepseek-chat" });
			expect(heuristic.estimator).toBe("heuristic");
			expect(real.estimator).toBe("gpt-tokenizer/cl100k_base");
			expect(real.surfaceTokens).not.toBe(heuristic.surfaceTokens);
			expect(real.surfaceTokens).toBeGreaterThan(heuristic.surfaceTokens);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("counts a plain-prose transcript lower than the density heuristic", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-tok-cmp-"));
		try {
			const path = writeSingleTextSession(dir, PROSE_TEXT);
			const heuristic = measureSessionTokens(path);
			const real = measureSessionTokens(path, { provider: "deepseek", model: "deepseek-chat" });
			expect(real.surfaceTokens).not.toBe(heuristic.surfaceTokens);
			expect(real.surfaceTokens).toBeLessThan(heuristic.surfaceTokens);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("counts a cjk-heavy transcript sharply higher than the density heuristic", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-tok-cmp-"));
		try {
			const path = writeSingleTextSession(dir, "世".repeat(1024));
			const heuristic = measureSessionTokens(path);
			const real = measureSessionTokens(path, { provider: "deepseek", model: "deepseek-chat" });
			// cl100k prices each CJK char at 2 tokens here (2048 for 1024
			// chars); the density heuristic prices the same text at 256.
			expect(real.surfaceTokens).toBeGreaterThan(4 * heuristic.surfaceTokens);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("gateway threads the active model into the token-pressure check (ADR-0060)", () => {
	/** Minimal streaming transport so the gateway exercises the streaming path. */
	function meterTransport() {
		const sent: Array<{ to: string; text: string }> = [];
		let id = 0;
		let handler: ((msg: GatewayMessage) => void) | undefined;
		const t: GatewayTransport & {
			sendMessage(to: GatewayRecipient, text: string): Promise<number>;
			editMessage(chatId: string, messageId: number, text: string): Promise<void>;
			sendChatAction(to: GatewayRecipient, action: string): Promise<void>;
		} = {
			async connect() {},
			async disconnect() {},
			async send(to, text) {
				sent.push({ to: to.recipient, text });
			},
			async sendMessage(to, text) {
				sent.push({ to: to.recipient, text });
				return ++id;
			},
			async editMessage(_chatId, _messageId, _text) {},
			async sendChatAction(_to, _action) {},
			onMessage(h) {
				handler = h;
			},
		};
		return { t, push: (msg: GatewayMessage) => handler?.(msg) };
	}

	/** Write a session that is CJK-dense: under budget heuristically, over budget on cl100k. */
	function writeCjkSession(sessionsDir: string): string {
		const path = sessionFilePath(sessionsDir, "+1");
		const lines = ["世".repeat(1024)].map((text, i) => textMessageEntry(`m${i + 1}`, text));
		for (let i = 1; i < 24; i += 1) lines.push(textMessageEntry(`m${i + 1}`, "世".repeat(1024)));
		writeFileSync(path, sessionJsonl(lines), "utf8");
		return path;
	}

	it("requests compaction when the active deepseek model prices the session over budget", async () => {
		const dir = await home("axiom-gw-tok-");
		try {
			const s = meterTransport();
			const completion = fakeCompletionRunner();
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const sessionPath = writeCjkSession(sessionsDir);
			// Preconditions that make this the tokenizer path, not the
			// heuristic or byte paths: the heuristic prices the surface under
			// the token budget while the deepseek cl100k count prices it over,
			// and the file stays under the byte budget.
			expect(measureSessionTokens(sessionPath).surfaceTokens).toBeLessThan(GATEWAY_SESSION_TOKEN_BUDGET);
			expect(
				measureSessionTokens(sessionPath, { provider: "deepseek", model: "deepseek-v4-flash" }).surfaceTokens,
			).toBeGreaterThan(GATEWAY_SESSION_TOKEN_BUDGET);
			expect(statSync(sessionPath).size).toBeLessThan(GATEWAY_SESSION_BUDGET_BYTES);
			const modelStore = new InMemoryActiveModelStore();
			modelStore.save({ provider: "deepseek", model: "deepseek-v4-flash" });
			const g = new Gateway({
				transport: s.t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				sessionsDir,
				modelStore,
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(existsSync(sessionPath)).toBe(true);
			expect(completion.calls.at(-1)).toMatchObject({ compactBefore: true });
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not request compaction for the same session without an active model", async () => {
		const dir = await home("axiom-gw-tok-");
		try {
			const s = meterTransport();
			const completion = fakeCompletionRunner();
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const sessionPath = writeCjkSession(sessionsDir);
			expect(measureSessionTokens(sessionPath).surfaceTokens).toBeLessThan(GATEWAY_SESSION_TOKEN_BUDGET);
			const g = new Gateway({
				transport: s.t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				sessionsDir,
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(completion.calls.at(-1)?.compactBefore).toBeUndefined();
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
