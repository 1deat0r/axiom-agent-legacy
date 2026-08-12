import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryChannelIndex } from "../../src/gateway/channel-index.js";
import { fakeCompletionRunner, sessionIdForChannel } from "../../src/gateway/completion.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { GatewayMessage, GatewayTransport } from "../../src/gateway/types.js";

/**
 * Discord-specific router path tests. The generic router behavior (allowlist
 * deny, command-vs-agent, per-channel serialization, session indexing) is
 * already covered by test/gateway/gateway.test.ts; these pin the Discord
 * channel-identity semantics into the router: the transport sets channelId =
 * the Discord channel id and sender = the author id, and the shared sender
 * allowlist gates on author id.
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

describe("Gateway router over Discord channel/author ids", () => {
	it("routes an allowlisted DM author to an agent completion and indexes the channel", async () => {
		const dir = await home("axiom-dgw-");
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
				senders: ["owner-user-id-42"], // author id allowlisted
			});
			await g.start();
			push({ channelId: "dm-777", sender: "owner-user-id-42", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(completion.calls).toHaveLength(1);
			// The channel index maps the Discord CHANNEL id (not the author) to a session.
			expect(completion.calls[0]!.sessionId).toBe(sessionIdForChannel("dm-777"));
			expect(index.get("dm-777")).toBe(sessionIdForChannel("dm-777"));
			expect(sent.some((s) => s.text.startsWith("axiom reply"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("denies a non-allowlisted author in a shared channel before the model", async () => {
		const dir = await home("axiom-dgw-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["owner-user-id-42"], // only the owner's author id
			});
			await g.start();
			// A stranger posts in a shared guild text channel the bot hears.
			push({ channelId: "guild-9", sender: "stranger-99", text: "/help", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.some((s) => s.text.includes("unrecognized sender"))).toBe(true);
			expect(completion.calls).toHaveLength(0);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("handles a Discord command locally and never calls the model", async () => {
		const dir = await home("axiom-dgw-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["owner-user-id-42"],
			});
			await g.start();
			push({ channelId: "dm-1", sender: "owner-user-id-42", text: "/profiles", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(completion.calls).toHaveLength(0);
			expect(sent.some((s) => s.text.includes("profiles"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
