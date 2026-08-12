import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryChannelIndex } from "../../src/gateway/channel-index.js";
import { fakeCompletionRunner, sessionIdForChannel } from "../../src/gateway/completion.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { GatewayMessage, GatewayTransport } from "../../src/gateway/types.js";

/**
 * Telegram-specific router path tests. The generic router behavior (allowlist
 * deny, command-vs-agent, per-channel serialization, session indexing) is
 * already covered by test/gateway/gateway.test.ts; these pin the Telegram
 * channel-identity semantics: channelId = sender = String(chat.id), negative
 * (group) chat ids denied by a positive-id allowlist unless explicitly listed.
 */

function fakeTransport() {
	const sent: Array<{ to: string; text: string }> = [];
	let handler: ((msg: GatewayMessage) => void) | undefined;
	const t: GatewayTransport = {
		async connect() {},
		async disconnect() {},
		async send(to, text) {
			sent.push({ to: to.recipient, text });
		},
		onMessage(h) {
			handler = h;
		},
	};
	return { t, sent, push: (m: GatewayMessage) => handler?.(m) };
}

async function home(prefix: string) {
	return mkdtemp(join(tmpdir(), prefix));
}

describe("Gateway router over Telegram chat ids", () => {
	it("routes an allowlisted private chat (positive id) to an agent completion", async () => {
		const dir = await home("axiom-tgw-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const index = new MemoryChannelIndex();
			const g = new Gateway({
				transport: t,
				index,
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["123456789"], // owner's personal chat id
			});
			await g.start();
			push({ channelId: "123456789", sender: "123456789", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(completion.calls).toHaveLength(1);
			expect(completion.calls[0]!.sessionId).toBe(sessionIdForChannel("123456789"));
			expect(index.get("123456789")).toBe(sessionIdForChannel("123456789"));
			expect(sent.some((s) => s.text.startsWith("axiom reply"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("denies a group chat (negative id) not in the allowlist before the model", async () => {
		const dir = await home("axiom-tgw-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["123456789"], // only the positive personal id
			});
			await g.start();
			// A group message: chat.id -100123, sender is that same group chat id (per transport).
			push({ channelId: "-100123", sender: "-100123", text: "/help", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.some((s) => s.text.includes("unrecognized sender"))).toBe(true);
			expect(completion.calls).toHaveLength(0);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("allows a group chat when its negative id is explicitly allowlisted", async () => {
		const dir = await home("axiom-tgw-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["-100123"],
			});
			await g.start();
			push({ channelId: "-100123", sender: "-100123", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(completion.calls).toHaveLength(1);
			expect(sent.some((s) => s.text.startsWith("axiom reply"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("handles a Telegram command locally and never calls the model", async () => {
		const dir = await home("axiom-tgw-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["42"],
			});
			await g.start();
			push({ channelId: "42", sender: "42", text: "/profiles", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(completion.calls).toHaveLength(0);
			expect(sent.some((s) => s.text.includes("profiles"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
