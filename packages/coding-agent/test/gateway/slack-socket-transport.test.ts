import { describe, expect, it } from "vitest";
import {
	isSafeSlackSocketUrl,
	isSlackSocketModeEnabled,
	redactSlackSecrets,
	SLACK_SOCKET_MAX_FRAME_CHARS,
	SLACK_SOCKET_RECONNECT_MS,
	type SlackSocket,
	type SlackSocketApi,
	SlackSocketTransport,
	type SlackSocketTransportOptions,
} from "../../src/gateway/transports/slack-socket.js";
import type { GatewayMessage } from "../../src/gateway/types.js";

/** A scripted WebSocket: the test drives open/message/close, records sends. */
function fakeSocket() {
	const acks: string[] = [];
	let closed = false;
	const socket: SlackSocket = {
		send(data: string) {
			acks.push(data);
		},
		close() {
			closed = true;
			socket.onclose?.({ code: 1000, reason: "test close" });
		},
		onopen: null,
		onmessage: null,
		onclose: null,
		onerror: null,
	};
	return {
		socket,
		acks,
		isClosed: () => closed,
		open() {
			socket.onopen?.({});
		},
		emit(data: string) {
			socket.onmessage?.({ data });
		},
		serverClose(code = 1001) {
			socket.onclose?.({ code, reason: "server closed" });
		},
		error() {
			socket.onerror?.({});
		},
	};
}

/** A scripted Slack API: open returns a canned url; postMessage records. */
function fakeApi(url = "wss://wss-primary.slack.com/link/?ticket=TICKET123&app_id=A123") {
	const sent: Array<{ channel: string; text: string }> = [];
	const openCalls: string[] = [];
	let openAttempts = 0;
	let openError: Error | undefined;
	const api: SlackSocketApi = {
		async appsConnectionsOpen() {
			openAttempts++;
			if (openError) throw openError;
			openCalls.push(url);
			return { url };
		},
		async postMessage(input) {
			sent.push({ channel: input.channel, text: input.text });
		},
	};
	return {
		api,
		sent,
		openCalls,
		openAttempts: () => openAttempts,
		setOpenError(e: Error | undefined) {
			openError = e;
		},
	};
}

function settle(ms = 25): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Build a well-formed Socket Mode events_api frame. */
function eventsFrame(envelopeId: string, event: Record<string, unknown>): string {
	return JSON.stringify({
		type: "events_api",
		envelope_id: envelopeId,
		payload: { type: "event_callback", event },
	});
}

/** A transport wired to one fake socket with a short reconnect delay. */
function harness(options: SlackSocketTransportOptions = {}) {
	const f = fakeApi();
	const sockets: ReturnType<typeof fakeSocket>[] = [];
	const factoryCalls: string[] = [];
	const transport = new SlackSocketTransport(f.api, {
		reconnectDelayMs: 5,
		socketFactory: (url) => {
			factoryCalls.push(url);
			const s = fakeSocket();
			sockets.push(s);
			return s.socket;
		},
		...options,
	});
	const delivered: GatewayMessage[] = [];
	transport.onMessage((msg) => delivered.push(msg));
	return { f, sockets, factoryCalls, transport, delivered };
}

describe("isSlackSocketModeEnabled (SLACK_SOCKET_MODE env gate)", () => {
	it("is false when the env var is absent or not a truthy gate", () => {
		expect(isSlackSocketModeEnabled({})).toBe(false);
		expect(isSlackSocketModeEnabled({ SLACK_SOCKET_MODE: "0" })).toBe(false);
		expect(isSlackSocketModeEnabled({ SLACK_SOCKET_MODE: "no" })).toBe(false);
		expect(isSlackSocketModeEnabled({ SLACK_SOCKET_MODE: "" })).toBe(false);
	});
	it("is true for the documented truthy values", () => {
		expect(isSlackSocketModeEnabled({ SLACK_SOCKET_MODE: "1" })).toBe(true);
		expect(isSlackSocketModeEnabled({ SLACK_SOCKET_MODE: "true" })).toBe(true);
		expect(isSlackSocketModeEnabled({ SLACK_SOCKET_MODE: "TRUE" })).toBe(true);
	});
});

describe("isSafeSlackSocketUrl", () => {
	it("accepts a wss url on slack.com", () => {
		expect(isSafeSlackSocketUrl("wss://wss-primary.slack.com/link/?ticket=x&app_id=y")).toBe(true);
		expect(isSafeSlackSocketUrl("wss://wss-backup.slack.com/link/")).toBe(true);
	});
	it("rejects http/ws schemes and non-slack hosts", () => {
		expect(isSafeSlackSocketUrl("https://slack.com/link/?ticket=x")).toBe(false);
		expect(isSafeSlackSocketUrl("ws://wss-primary.slack.com/link/")).toBe(false);
		expect(isSafeSlackSocketUrl("wss://wss-primary.slack.com.evil.example/link/")).toBe(false);
		expect(isSafeSlackSocketUrl("wss://evil.example/link/")).toBe(false);
		expect(isSafeSlackSocketUrl("not a url")).toBe(false);
	});
});

describe("redactSlackSecrets", () => {
	it("replaces tokens and ticket query values, never the rest", () => {
		const line = "connect failed for https://api.slack.com/apps.connections.open ticket=abcDEF123 xapp-1-SECRET";
		const out = redactSlackSecrets(line, ["xapp-1-SECRET", "xoxb-BOTSECRET"]);
		expect(out).not.toContain("abcDEF123");
		expect(out).not.toContain("xapp-1-SECRET");
		expect(out).not.toContain("xoxb-BOTSECRET");
		expect(out).toContain("[redacted]");
		expect(out).toContain("connect failed");
	});
	it("leaves a clean line untouched", () => {
		expect(redactSlackSecrets("slack socket opened", ["xapp-1"])).toBe("slack socket opened");
	});
});

describe("SlackSocketTransport (Socket Mode receive)", () => {
	it("opens the socket at the apps.connections.open url and reports running", async () => {
		const h = harness();
		await h.transport.connect();
		await settle();
		expect(h.f.openCalls).toEqual(["wss://wss-primary.slack.com/link/?ticket=TICKET123&app_id=A123"]);
		expect(h.factoryCalls).toEqual(["wss://wss-primary.slack.com/link/?ticket=TICKET123&app_id=A123"]);
		expect(h.transport.isRunning()).toBe(true);
		// The socket is not considered open until the server side opens.
		expect(h.sockets[0]!.acks).toHaveLength(0);
		h.sockets[0]!.open();
		await settle();
		await h.transport.disconnect();
		expect(h.transport.isRunning()).toBe(false);
	});

	it("delivers a message event and acks its envelope", async () => {
		const h = harness();
		await h.transport.connect();
		await settle();
		const s = h.sockets[0]!;
		s.open();
		await settle(); // let the transport install the message handler
		s.emit(eventsFrame("env-1", { type: "message", user: "U42", text: "hello", ts: "1234567.500", channel: "C9" }));
		await settle();
		expect(h.delivered).toHaveLength(1);
		expect(h.delivered[0]).toEqual({
			channelId: "C9",
			sender: "U42",
			text: "hello",
			isCommand: false,
			timestamp: 1234567500,
		});
		expect(s.acks).toEqual([JSON.stringify({ envelope_id: "env-1" })]);
		await h.transport.disconnect();
	});

	it("ignores hello and unknown frame types without acking or delivering", async () => {
		const h = harness();
		await h.transport.connect();
		await settle();
		const s = h.sockets[0]!;
		s.open();
		await settle(); // let the transport install the message handler
		s.emit(JSON.stringify({ type: "hello", connection_info: { app_id: "A123" } }));
		s.emit(JSON.stringify({ type: "pong" }));
		s.emit(JSON.stringify({ type: "events_api", envelope_id: "", payload: {} }));
		await settle();
		expect(h.delivered).toHaveLength(0);
		expect(s.acks).toHaveLength(0);
		await h.transport.disconnect();
	});

	it("reconnects after a disconnect frame, opening a fresh socket", async () => {
		const h = harness();
		await h.transport.connect();
		await settle();
		const first = h.sockets[0]!;
		first.open();
		await settle(); // let the transport install the message handler
		first.emit(JSON.stringify({ type: "disconnect", reason: "refresh_disconnect_url" }));
		await settle(60);
		expect(first.isClosed()).toBe(true);
		expect(h.sockets.length).toBeGreaterThanOrEqual(2);
		expect(h.factoryCalls).toHaveLength(2);
		await h.transport.disconnect();
	});

	it("reconnects after an apps.connections.open failure, with secrets redacted", async () => {
		const logs: string[] = [];
		const h = harness({ logger: (line) => logs.push(line), secrets: ["xapp-1-SECRET"] });
		h.f.setOpenError(new Error("slack apps.connections.open rejected for ticket=LEAKME with xapp-1-SECRET"));
		await h.transport.connect();
		await settle(40);
		expect(logs.some((l) => l.includes("LEAKME") || l.includes("xapp-1-SECRET"))).toBe(false);
		expect(logs.some((l) => l.includes("[redacted]"))).toBe(true);
		// The transport kept trying: at least one retry open attempt.
		expect(h.f.openAttempts()).toBeGreaterThanOrEqual(2);
		await h.transport.disconnect();
	});

	it("sends replies over the REST client, chunking long text in order", async () => {
		const h = harness();
		await h.transport.connect();
		await settle();
		const long = "word ".repeat(9_000).trimEnd(); // ~45k chars: well past the 40k cap
		await h.transport.send({ channelId: "C9", recipient: "U42" }, long);
		expect(h.f.sent.length).toBeGreaterThan(1);
		expect(h.f.sent.every((s) => s.channel === "C9")).toBe(true);
		// Ordered word sequence equals the original words.
		const words = h.f.sent
			.map((s) => s.text)
			.join(" ")
			.split(/\s+/)
			.filter((w) => w.length > 0);
		expect(words).toEqual(long.split(/\s+/).filter((w) => w.length > 0));
		await h.transport.disconnect();
	});

	it("logs a send failure (redacted) and stops the batch", async () => {
		const logs: string[] = [];
		const h = harness({ logger: (line) => logs.push(line), secrets: ["xoxb-BOTSECRET"] });
		await h.transport.connect();
		await settle();
		h.f.api.postMessage = async () => {
			throw new Error("postMessage failed with xoxb-BOTSECRET");
		};
		await h.transport.send({ channelId: "C9", recipient: "U42" }, "a b c");
		expect(logs.some((l) => l.includes("send failed"))).toBe(true);
		expect(logs.some((l) => l.includes("xoxb-BOTSECRET"))).toBe(false);
		expect(logs.some((l) => l.includes("[redacted]"))).toBe(true);
		await h.transport.disconnect();
	});

	it("exposes the documented defaults", () => {
		expect(SLACK_SOCKET_RECONNECT_MS).toBe(3_000);
		expect(SLACK_SOCKET_MAX_FRAME_CHARS).toBeGreaterThan(40_000);
	});
});
