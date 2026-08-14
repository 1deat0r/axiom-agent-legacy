/**
 * Threat corpus for the Slack Socket Mode receive path (issue #40, S-class
 * transport receive). Every case here is an attack on the NEW socket-mode
 * module and FAILS on pre-change code (the module does not exist). The corpus
 * is permanent: each case encodes a forged-frame / replay / leakage invariant
 * the transport must keep holding.
 *
 * Cases:
 *  1. forged socket payload (events_api whose payload is not an event_callback)
 *  2. forged event shape (event_callback whose event is not a message)
 *  3. forged sender/channel (missing or empty user/channel/text)
 *  4. malformed frames (non-JSON, JSON array, bad envelope) never kill the loop
 *  5. replay of a delivered message (same envelope delivered once, acked again)
 *  6. oversized frame handling (dropped unread, loop survives)
 *  7. token leakage into logs (tickets + tokens redacted on every log line)
 *  8. forged socket url (apps.connections.open cannot redirect the socket)
 *  9. forged channel override (a side-channel field cannot reroute the delivery)
 */
import { describe, expect, it } from "vitest";
import {
	type SlackSocket,
	type SlackSocketApi,
	SlackSocketTransport,
	type SlackSocketTransportOptions,
} from "../../src/gateway/transports/slack-socket.js";
import type { GatewayMessage } from "../../src/gateway/types.js";

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
	};
}

function threatHarness(options: SlackSocketTransportOptions = {}) {
	const sent: Array<{ channel: string; text: string }> = [];
	const logs: string[] = [];
	const factoryCalls: string[] = [];
	const sockets: ReturnType<typeof fakeSocket>[] = [];
	const api: SlackSocketApi = {
		async appsConnectionsOpen() {
			return { url: "wss://wss-primary.slack.com/link/?ticket=TICKET123&app_id=A123" };
		},
		async postMessage(input) {
			sent.push({ channel: input.channel, text: input.text });
		},
	};
	const transport = new SlackSocketTransport(api, {
		reconnectDelayMs: 5,
		logger: (line) => logs.push(line),
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
	return { transport, delivered, logs, factoryCalls, sockets, acksOf: (i: number) => sockets[i]!.acks };
}

function frame(envelopeId: string, payload: unknown): string {
	return JSON.stringify({ type: "events_api", envelope_id: envelopeId, payload });
}

function settle(ms = 25): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function openedSocket(h: ReturnType<typeof threatHarness>) {
	await h.transport.connect();
	await settle();
	const s = h.sockets[0]!;
	s.open();
	return s;
}

describe("Slack Socket Mode threat corpus (issue #40)", () => {
	it("case 1: a forged events_api payload that is not an event_callback is never delivered", async () => {
		const h = threatHarness();
		const s = await openedSocket(h);
		// A forged interactive/url_verification payload riding an events_api frame.
		s.emit(frame("e1", { type: "url_verification", token: "forged", challenge: "forged" }));
		await settle();
		expect(h.delivered).toHaveLength(0);
		// Protocol-correct: the envelope is still acked so Slack never resends.
		expect(h.acksOf(0)).toEqual([JSON.stringify({ envelope_id: "e1" })]);
		await h.transport.disconnect();
	});

	it("case 2: a forged event whose type is not message is never delivered", async () => {
		const h = threatHarness();
		const s = await openedSocket(h);
		s.emit(
			frame("e2", { type: "event_callback", event: { type: "app_mention", user: "U", text: "hi", channel: "C" } }),
		);
		s.emit(frame("e3", { type: "event_callback", event: { type: "reaction_added", user: "U", channel: "C" } }));
		await settle();
		expect(h.delivered).toHaveLength(0);
		await h.transport.disconnect();
	});

	it("case 3: a forged event with missing or empty user/channel/text is never delivered", async () => {
		const h = threatHarness();
		const s = await openedSocket(h);
		s.emit(frame("e4", { type: "event_callback", event: { type: "message", text: "no user here", channel: "C" } }));
		s.emit(
			frame("e5", {
				type: "event_callback",
				event: { type: "message", user: "U", text: "no channel", channel: "" },
			}),
		);
		s.emit(frame("e6", { type: "event_callback", event: { type: "message", user: "U", channel: "C", text: "" } }));
		await settle();
		expect(h.delivered).toHaveLength(0);
		await h.transport.disconnect();
	});

	it("case 4: malformed frames never kill the receive loop and never deliver", async () => {
		const h = threatHarness();
		const s = await openedSocket(h);
		s.emit("this is not json at all");
		s.emit("[1,2,3]");
		s.emit(JSON.stringify({ type: "events_api", payload: { type: "event_callback" } })); // no envelope_id
		s.emit(JSON.stringify({ type: "events_api", envelope_id: "e7" })); // no payload
		s.emit("42");
		await settle();
		expect(h.delivered).toHaveLength(0);
		// The loop survives: the very next well-formed frame delivers.
		s.emit(
			frame("e8", {
				type: "event_callback",
				event: { type: "message", user: "U", text: "still alive", channel: "C" },
			}),
		);
		await settle();
		expect(h.delivered).toHaveLength(1);
		expect(h.delivered[0]!.text).toBe("still alive");
		await h.transport.disconnect();
	});

	it("case 5: a replayed envelope is acked but never delivered twice", async () => {
		const h = threatHarness();
		const s = await openedSocket(h);
		const payload = {
			type: "event_callback",
			event: { type: "message", user: "U", text: "one delivery only", channel: "C" },
		};
		s.emit(frame("e9", payload));
		s.emit(frame("e9", payload)); // replay of the delivered envelope
		await settle();
		expect(h.delivered).toHaveLength(1);
		// Both frames acked (idempotent ack), delivery stayed single.
		expect(h.acksOf(0)).toEqual([JSON.stringify({ envelope_id: "e9" }), JSON.stringify({ envelope_id: "e9" })]);
		await h.transport.disconnect();
	});

	it("case 6: an oversized frame is dropped unread and the loop survives", async () => {
		const h = threatHarness({ maxFrameChars: 1024 });
		const s = await openedSocket(h);
		const huge = frame("e10", {
			type: "event_callback",
			event: { type: "message", user: "U", text: "x".repeat(2048), channel: "C" },
		});
		s.emit(huge);
		await settle();
		expect(h.delivered).toHaveLength(0);
		expect(h.acksOf(0)).toHaveLength(0); // dropped before parsing: never acked
		// A normal frame still delivers.
		s.emit(
			frame("e11", {
				type: "event_callback",
				event: { type: "message", user: "U", text: "after the flood", channel: "C" },
			}),
		);
		await settle();
		expect(h.delivered).toHaveLength(1);
		await h.transport.disconnect();
	});

	it("case 7: tokens and tickets never reach the logger, even inside error text", async () => {
		const logs: string[] = [];
		const api: SlackSocketApi = {
			async appsConnectionsOpen() {
				throw new Error(
					"open rejected: https://api.slack.com/apps.connections.open?ticket=LEAKME with xapp-1-SECRET and xoxb-BOTSECRET",
				);
			},
			async postMessage() {},
		};
		const t = new SlackSocketTransport(api, {
			reconnectDelayMs: 5,
			logger: (line) => logs.push(line),
			secrets: ["xapp-1-SECRET", "xoxb-BOTSECRET"],
			socketFactory: () => {
				throw new Error("should never be reached");
			},
		});
		await t.connect();
		await settle(40);
		await t.disconnect();
		expect(logs.length).toBeGreaterThan(0);
		for (const line of logs) {
			expect(line).not.toContain("LEAKME");
			expect(line).not.toContain("xapp-1-SECRET");
			expect(line).not.toContain("xoxb-BOTSECRET");
		}
		expect(logs.some((l) => l.includes("[redacted]"))).toBe(true);
	});

	it("case 8: a forged apps.connections.open url can never redirect the socket", async () => {
		const evilUrls = [
			"https://slack.com.evil.example/link/",
			"ws://wss-primary.slack.com/link/",
			"wss://evil.example/steal",
		];
		let call = 0;
		// Rebind the api to answer with a forged url per attempt.
		const api: SlackSocketApi = {
			async appsConnectionsOpen() {
				return { url: evilUrls[Math.min(call++, evilUrls.length - 1)] ?? "wss://evil.example/steal" };
			},
			async postMessage() {},
		};
		const logs: string[] = [];
		const factoryCalls: string[] = [];
		const t = new SlackSocketTransport(api, {
			reconnectDelayMs: 5,
			logger: (line) => logs.push(line),
			socketFactory: (url) => {
				factoryCalls.push(url);
				return fakeSocket().socket;
			},
		});
		await t.connect();
		await settle(60);
		expect(factoryCalls).toHaveLength(0); // never opened a socket at a forged url
		expect(logs.some((l) => l.includes("unsafe url"))).toBe(true);
		await t.disconnect();
	});

	it("case 9: a forged side-channel field cannot reroute a message away from its event channel", async () => {
		const h = threatHarness();
		const s = await openedSocket(h);
		// The attacker claims the event lives on C-REAL but tries to override the
		// delivery target with an extra payload-level channel field.
		s.emit(
			JSON.stringify({
				type: "events_api",
				envelope_id: "e12",
				payload: {
					type: "event_callback",
					channel: "C-FAKE",
					event: { type: "message", user: "U", text: "route me", channel: "C-REAL" },
				},
			}),
		);
		await settle();
		expect(h.delivered).toHaveLength(1);
		expect(h.delivered[0]!.channelId).toBe("C-REAL");
		expect(h.delivered[0]!.sender).toBe("U");
		await h.transport.disconnect();
	});
});
