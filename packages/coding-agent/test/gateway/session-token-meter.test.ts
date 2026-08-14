import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryChannelIndex } from "../../src/gateway/channel-index.js";
import { fakeCompletionRunner } from "../../src/gateway/completion.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { GATEWAY_SESSION_BUDGET_BYTES, sessionFilePath } from "../../src/gateway/session-reset.js";
import {
	BLOCK_OVERHEAD,
	CHARS_PER_TOKEN,
	estimateContentTokens,
	estimateMessageTokens,
	estimateTextTokens,
	exceedsTokenBudget,
	GATEWAY_SESSION_TOKEN_BUDGET,
	measureSessionTokens,
	ROLE_OVERHEAD,
	sessionExceedsTokenBudget,
} from "../../src/gateway/session-token-meter.js";
import type { GatewayMessage, GatewayRecipient, GatewayTransport } from "../../src/gateway/types.js";

/** A scratch home directory under the system temp dir. */
async function home(prefix: string) {
	return mkdtemp(join(tmpdir(), prefix));
}

/** A session JSONL built from a session header plus the given raw lines. */
function sessionJsonl(lines: string[]): string {
	return `${['{"type":"session","version":3,"id":"gw-token-meter","timestamp":"2026-08-14T00:00:00.000Z"}', ...lines].join("\n")}\n`;
}

/** One message entry with a single text block of the given length. */
function textMessageEntry(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-14T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	});
}

describe("Session token meter estimator (ADR-0055)", () => {
	it("prices a string at one token per CHARS_PER_TOKEN characters, rounded up", () => {
		expect(estimateTextTokens("")).toBe(0);
		expect(estimateTextTokens("a")).toBe(1);
		expect(estimateTextTokens("abcd")).toBe(1);
		expect(estimateTextTokens("abcde")).toBe(2);
		expect(CHARS_PER_TOKEN).toBe(4);
	});

	it("prices a text block as its text plus the block overhead", () => {
		const tokens = estimateContentTokens([{ type: "text", text: "abcd" }]);
		expect(tokens).toBe(1 + BLOCK_OVERHEAD);
	});

	it("prices a thinking block like a text block", () => {
		const text = estimateContentTokens([{ type: "text", text: "abcdefgh" }]);
		const thinking = estimateContentTokens([{ type: "thinking", thinking: "abcdefgh" }]);
		expect(thinking).toBe(text);
	});

	it("prices a toolCall block by name and stringified arguments", () => {
		const tokens = estimateContentTokens([
			{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } },
		]);
		const expectedArgs = Math.ceil(JSON.stringify({ command: "echo hi" }).length / CHARS_PER_TOKEN);
		expect(tokens).toBe(BLOCK_OVERHEAD + Math.ceil("bash".length / CHARS_PER_TOKEN) + expectedArgs);
	});

	it("prices nested toolResult content plus the tool name", () => {
		const tokens = estimateContentTokens([
			{
				type: "toolResult",
				toolCallId: "call_1",
				name: "ipython",
				content: [{ type: "text", text: "output text" }],
			},
		]);
		const expectedContent = Math.ceil("output text".length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
		expect(tokens).toBe(BLOCK_OVERHEAD + Math.ceil("ipython".length / CHARS_PER_TOKEN) + expectedContent);
	});

	it("adds role overhead to every message and tool-name overhead to toolResult messages", () => {
		const content = [{ type: "text", text: "abcd" }];
		const plain = estimateMessageTokens({ role: "user", content });
		expect(plain).toBe(estimateContentTokens(content) + ROLE_OVERHEAD);
		const result = estimateMessageTokens({ role: "toolResult", toolName: "bash", content });
		expect(result).toBe(
			estimateContentTokens(content) + ROLE_OVERHEAD + BLOCK_OVERHEAD + Math.ceil("bash".length / CHARS_PER_TOKEN),
		);
	});

	it("prices an unknown block type by its JSON so new shapes never read as free surface", () => {
		const tokens = estimateContentTokens([{ type: "futureBlock", payload: "some content" }]);
		expect(tokens).toBe(
			BLOCK_OVERHEAD +
				Math.ceil(JSON.stringify({ type: "futureBlock", payload: "some content" }).length / CHARS_PER_TOKEN),
		);
	});

	it("is deterministic: the same input prices identically every time", () => {
		const blocks = [
			{ type: "text", text: "hello world, this is a test" },
			{ type: "toolCall", name: "bash", arguments: { command: "echo deterministic" } },
			{ type: "thinking", thinking: "thinking through this" },
		];
		const first = estimateContentTokens(blocks);
		const second = estimateContentTokens(blocks);
		expect(second).toBe(first);
		expect(first).toBeGreaterThan(0);
	});
});

describe("Session token meter snapshot (ADR-0055)", () => {
	it("measures a missing file as a frozen zero snapshot at revision 0", () => {
		const snapshot = measureSessionTokens(join(tmpdir(), "does-not-exist.jsonl"));
		expect(snapshot.revision).toBe(0);
		expect(snapshot.surfaceTokens).toBe(0);
		expect(snapshot.pricedMessages).toBe(0);
		expect(snapshot.estimator).toBe("heuristic");
		expect(Object.isFrozen(snapshot)).toBe(true);
	});

	it("measures an unreadable path as a zero snapshot instead of throwing", () => {
		// A directory exists but cannot be read as a file: the meter must
		// never block a reply on a bad read.
		const snapshot = measureSessionTokens(tmpdir());
		expect(snapshot.revision).toBe(0);
		expect(snapshot.surfaceTokens).toBe(0);
	});

	it("prices only message entries and counts the revision as entries consumed", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-token-meter-"));
		try {
			const path = join(dir, "s.jsonl");
			writeFileSync(
				path,
				sessionJsonl([
					textMessageEntry("m1", "abcdefgh"), // 2 + 4 + 4 = 10 tokens
					'{"type":"model_change","provider":"deepseek","modelId":"deepseek-v4-flash"}',
					textMessageEntry("m2", "abcdefgh"), // 10 tokens
					'{"type":"session_state","state":{"status":"active"}}',
				]),
				"utf8",
			);
			const snapshot = measureSessionTokens(path);
			expect(snapshot.revision).toBe(5); // header + 4 entries
			expect(snapshot.pricedMessages).toBe(2);
			expect(snapshot.malformedEntries).toBe(0);
			expect(snapshot.surfaceTokens).toBe(20);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips malformed lines but still advances the revision and counts them", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-token-meter-"));
		try {
			const path = join(dir, "s.jsonl");
			writeFileSync(
				path,
				sessionJsonl([
					textMessageEntry("m1", "abcdefgh"), // 10 tokens
					"{not valid json",
					textMessageEntry("m2", "abcdefgh"), // 10 tokens
				]),
				"utf8",
			);
			const snapshot = measureSessionTokens(path);
			expect(snapshot.revision).toBe(4); // header + 3 lines, malformed included
			expect(snapshot.pricedMessages).toBe(2);
			expect(snapshot.malformedEntries).toBe(1);
			expect(snapshot.surfaceTokens).toBe(20);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not count the trailing newline as an entry", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-token-meter-"));
		try {
			const path = join(dir, "s.jsonl");
			writeFileSync(path, sessionJsonl([textMessageEntry("m1", "abcdefgh")]), "utf8");
			expect(measureSessionTokens(path).revision).toBe(2); // header + 1 message
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns an immutable snapshot that rejects mutation", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-token-meter-"));
		try {
			const path = join(dir, "s.jsonl");
			writeFileSync(path, sessionJsonl([textMessageEntry("m1", "abcdefgh")]), "utf8");
			const snapshot = measureSessionTokens(path);
			expect(Object.isFrozen(snapshot)).toBe(true);
			expect(() => {
				const mutable = snapshot as unknown as { surfaceTokens: number };
				mutable.surfaceTokens = 999;
			}).toThrow(TypeError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prices a toolResult message entry the way the estimator prices its content", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-token-meter-"));
		try {
			const path = join(dir, "s.jsonl");
			const entry = JSON.stringify({
				type: "message",
				id: "r1",
				parentId: null,
				timestamp: "2026-08-14T00:00:01.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "bash",
					content: [{ type: "text", text: "output text" }],
				},
			});
			writeFileSync(path, sessionJsonl([entry]), "utf8");
			const snapshot = measureSessionTokens(path);
			const expected = estimateMessageTokens({
				role: "toolResult",
				toolName: "bash",
				content: [{ type: "text", text: "output text" }],
			});
			expect(snapshot.surfaceTokens).toBe(expected);
			expect(snapshot.pricedMessages).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Session token budget predicate (ADR-0055)", () => {
	it("exceedsTokenBudget is strict: at the bound it does not fire", () => {
		const at = measureSessionTokens(join(tmpdir(), "missing.jsonl"));
		expect(
			exceedsTokenBudget({ ...at, surfaceTokens: GATEWAY_SESSION_TOKEN_BUDGET }, GATEWAY_SESSION_TOKEN_BUDGET),
		).toBe(false);
		expect(
			exceedsTokenBudget({ ...at, surfaceTokens: GATEWAY_SESSION_TOKEN_BUDGET + 1 }, GATEWAY_SESSION_TOKEN_BUDGET),
		).toBe(true);
	});

	it("sessionExceedsTokenBudget reads the file and never blocks on a missing one", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-token-meter-"));
		try {
			const missing = join(dir, "missing.jsonl");
			expect(sessionExceedsTokenBudget(missing)).toBe(false);
			const path = join(dir, "heavy.jsonl");
			const text = "a".repeat(1024); // 264 tokens per message
			const lines = [textMessageEntry("m1", text)];
			for (let i = 0; i < 190; i += 1) lines.push(textMessageEntry(`m${i + 2}`, text));
			writeFileSync(path, sessionJsonl(lines), "utf8");
			expect(measureSessionTokens(path).surfaceTokens).toBeGreaterThan(GATEWAY_SESSION_TOKEN_BUDGET);
			expect(sessionExceedsTokenBudget(path)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Gateway token-pressure compaction (ADR-0055)", () => {
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

	/** Write a token-heavy session whose FILE stays under the byte budget. */
	function writeTokenHeavySession(sessionsDir: string): string {
		const path = sessionFilePath(sessionsDir, "+1");
		const text = "a".repeat(1024); // 256 + block + role = 264 tokens per message
		const lines = [textMessageEntry("m1", text)];
		for (let i = 0; i < 190; i += 1) lines.push(textMessageEntry(`m${i + 2}`, text));
		writeFileSync(path, sessionJsonl(lines), "utf8");
		return path;
	}

	it("requests compaction for a token-heavy session that stays under the byte budget", async () => {
		const dir = await home("axiom-gw-token-");
		try {
			const s = meterTransport();
			const completion = fakeCompletionRunner();
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const sessionPath = writeTokenHeavySession(sessionsDir);
			// Preconditions that make this the token-pressure path, not the
			// byte path: the surface prices above the token budget while the
			// file stays under the byte budget.
			expect(statSync(sessionPath).size).toBeLessThan(GATEWAY_SESSION_BUDGET_BYTES);
			expect(measureSessionTokens(sessionPath).surfaceTokens).toBeGreaterThan(GATEWAY_SESSION_TOKEN_BUDGET);
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
			// The session is not archived: the run is flagged compactBefore so
			// the child summarizes the context.
			expect(existsSync(sessionPath)).toBe(true);
			expect(completion.calls.at(-1)).toMatchObject({ compactBefore: true });
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not request compaction for a token-light session", async () => {
		const dir = await home("axiom-gw-token-");
		try {
			const s = meterTransport();
			const completion = fakeCompletionRunner();
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const path = sessionFilePath(sessionsDir, "+1");
			writeFileSync(path, sessionJsonl([textMessageEntry("m1", "short message")]), "utf8");
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

	it("still requests compaction for a byte-heavy session the meter prices at zero", async () => {
		const dir = await home("axiom-gw-token-");
		try {
			const s = meterTransport();
			const completion = fakeCompletionRunner();
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const sessionPath = sessionFilePath(sessionsDir, "+1");
			// A giant line that is not JSON: the meter prices zero surface
			// tokens, but the byte budget remains the safety limit.
			writeFileSync(sessionPath, `${"x".repeat(GATEWAY_SESSION_BUDGET_BYTES + 1)}\n`, "utf8");
			expect(measureSessionTokens(sessionPath).surfaceTokens).toBe(0);
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
			expect(completion.calls.at(-1)).toMatchObject({ compactBefore: true });
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
