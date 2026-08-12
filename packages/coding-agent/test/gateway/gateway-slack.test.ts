import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryChannelIndex } from "../../src/gateway/channel-index.js";
import { fakeCompletionRunner, sessionIdForChannel } from "../../src/gateway/completion.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { GatewayMessage, GatewayTransport } from "../../src/gateway/types.js";

/**
 * Slack-specific router path tests. The generic router behavior (allowlist
 * deny, command-vs-agent, serialization, session indexing) is already covered
 * by gateway.test.ts; these pin the Slack channel-identity semantics into the
 * router: channelId = Slack channel id, sender = author's Slack user id, with
 * the shared sender allowlist gating on user id.
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

describe("Gateway router over Slack channel/user ids", () => {
	it("routes an allowlisted Slack user to an agent completion and indexes the channel", async () => {
		const dir = await home("axiom-sgw-");
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
				senders: ["U-OWNER-42"], // author user id allowlisted
			});
			await g.start();
			push({ channelId: "C-777", sender: "U-OWNER-42", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(completion.calls).toHaveLength(1);
			// Channel index maps the Slack CHANNEL id (not user) to a session.
			expect(completion.calls[0]!.sessionId).toBe(sessionIdForChannel("C-777"));
			expect(index.get("C-777")).toBe(sessionIdForChannel("C-777"));
			expect(sent.some((s) => s.text.startsWith("axiom reply"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("denies a non-allowlisted user in a shared channel before the model", async () => {
		const dir = await home("axiom-sgw-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["U-OWNER-42"],
			});
			await g.start();
			push({ channelId: "C-9", sender: "U-STRANGER", text: "/help", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.some((s) => s.text.includes("unrecognized sender"))).toBe(true);
			expect(completion.calls).toHaveLength(0);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("handles a Slack command locally and never calls the model", async () => {
		const dir = await home("axiom-sgw-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["U-OWNER-42"],
			});
			await g.start();
			push({ channelId: "C-1", sender: "U-OWNER-42", text: "/profiles", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(completion.calls).toHaveLength(0);
			expect(sent.some((s) => s.text.includes("profiles"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
