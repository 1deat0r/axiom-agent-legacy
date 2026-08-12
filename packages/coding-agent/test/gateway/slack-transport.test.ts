import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	chunkSlackText,
	FATAL_SLACK_ERRORS,
	FileSlackCursorStore,
	HttpSlackClient,
	isFatalSlackError,
	SLACK_TEXT_LIMIT,
	type SlackChannel,
	type SlackClient,
	type SlackMessage,
	SlackTransport,
	slackTsToMs,
} from "../../src/gateway/transports/slack.js";

/** An in-memory Slack client. `queue` holds undelivered messages per channel. */
function fakeClient(channels: SlackChannel[] = []) {
	const sent: Array<{ channel: string; text: string }> = [];
	const queue = new Map<string, SlackMessage[]>();
	const oldestCalls: Array<string | undefined> = [];
	let listFails = 0;
	const channelFails = new Map<string, number>();
	let fatal: Error | undefined;
	const client: SlackClient = {
		async postMessage(input) {
			sent.push({ channel: input.channel, text: input.text });
		},
		async listChannels() {
			if (fatal) throw fatal;
			if (listFails > 0) {
				listFails--;
				throw Object.assign(new Error("network down"), { status: 502 });
			}
			return channels;
		},
		async history(input) {
			oldestCalls.push(input.oldest);
			if (fatal) throw fatal;
			const remaining = channelFails.get(input.channel) ?? 0;
			if (remaining > 0) {
				channelFails.set(input.channel, remaining - 1);
				throw Object.assign(new Error("channel_not_found"), { status: 400, slackError: "channel_not_found" });
			}
			const all = queue.get(input.channel) ?? [];
			// conversations.history `oldest` is inclusive: return ts >= oldest so the
			// transport's exclusive filter (ts.gt.cursor) is genuinely exercised.
			const batch = input.oldest === undefined ? all : all.filter((m) => m.ts! >= input.oldest!);
			return batch;
		},
	};
	return {
		client,
		sent,
		oldestCalls,
		queue,
		setListFails(n: number) {
			listFails = n;
		},
		setChannelFails(channel: string, n: number) {
			channelFails.set(channel, n);
		},
		setFatal(e: Error | undefined) {
			fatal = e;
		},
	};
}

function msg(ts: string, channel: string, text: string, user = "owner"): SlackMessage {
	return { user, text, ts, channel };
}

async function settle(ms = 30) {
	await new Promise((r) => setTimeout(r, ms));
}

/** The ordered word sequence of a chunked send equals the original words. */
function words(text: string): string[] {
	return text.split(/\s+/).filter((w) => w.length > 0);
}

describe("chunkSlackText", () => {
	it("leaves short text as a single chunk", () => {
		expect(chunkSlackText("hello")).toEqual(["hello"]);
	});
	it("splits at the cap at the last whitespace at or before it", () => {
		const text = `${"a".repeat(SLACK_TEXT_LIMIT - 5)} ${"b".repeat(10)}`;
		const chunks = chunkSlackText(text);
		expect(chunks.every((c) => c.length <= SLACK_TEXT_LIMIT)).toBe(true);
		expect(chunks[0]!.length <= SLACK_TEXT_LIMIT).toBe(true);
	});
});

describe("slackTsToMs", () => {
	it("converts a Slack ts to epoch ms", () => {
		// 1234567890.123456 -> seconds * 1000
		expect(slackTsToMs("1234567.500")).toBe(1234567500);
	});
	it("falls back to Date.now for a malformed ts", () => {
		const before = Date.now();
		const v = slackTsToMs("not-a-ts");
		expect(v).toBeGreaterThanOrEqual(before);
	});
});

describe("SlackTransport", () => {
	it("sends text to the channel and chunks long replies in order", async () => {
		const f = fakeClient();
		const t = new SlackTransport(f.client, { pollIntervalMs: 1 });
		await t.connect();
		await t.send({ channelId: "C1", recipient: "U1" }, "hi");
		const long = "w ".repeat(SLACK_TEXT_LIMIT + 5); // over one chunk
		await t.send({ channelId: "C1", recipient: "U1" }, long);
		expect(f.sent[0]).toEqual({ channel: "C1", text: "hi" });
		const chunks = f.sent.slice(1);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((s) => s.text.length <= SLACK_TEXT_LIMIT)).toBe(true);
		expect(chunks.every((s) => s.channel === "C1")).toBe(true);
		expect(words(chunks.map((s) => s.text).join(" "))).toEqual(words(long));
		await t.disconnect();
	});

	it("delivers a DM with channel id + author user id", async () => {
		const f = fakeClient([{ id: "C-dm" }]);
		f.queue.set("C-dm", [msg("100.1", "C-dm", "hello")]);
		const t = new SlackTransport(f.client, { pollIntervalMs: 1 });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(40);
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: "C-dm", sender: "owner", text: "hello", isCommand: false }),
		);
		expect(handler.mock.calls[0]![0].timestamp).toBe(100100);
		await t.disconnect();
	});

	it("advances the per-channel cursor so already-delivered messages are not redelivered within a run", async () => {
		const f = fakeClient([{ id: "C1" }]);
		f.queue.set("C1", [msg("1.0", "C1", "a"), msg("2.0", "C1", "b")]);
		const t = new SlackTransport(f.client, { pollIntervalMs: 1 });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(40);
		expect(handler).toHaveBeenCalledTimes(2);
		expect(f.oldestCalls.some((o) => o === "2.0")).toBe(true); // next poll asks after newest ts
		await settle(30);
		expect(handler).toHaveBeenCalledTimes(2);
		await t.disconnect();
	});

	it("never replays the inclusive-oldest boundary message on resume", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-sl-cursor-"));
		try {
			await mkdir(dir, { recursive: true });
			const file = join(dir, "cursors.json");
			const store = new FileSlackCursorStore(file);
			// Run 1: deliver ts 5.0 on channel C -> cursor persisted as 5.0.
			const a = fakeClient([{ id: "C" }]);
			a.queue.set("C", [msg("5.0", "C", "a")]);
			const t1 = new SlackTransport(a.client, { cursorStore: store, pollIntervalMs: 1 });
			t1.onMessage(() => {});
			await t1.connect();
			await settle(40);
			await t1.disconnect();
			expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ C: "5.0" });

			// Run 2: conversations.history returns ts >= 5.0 INCLUSIVE, so the boundary
			// message 5.0 must NOT be redelivered; only a newer 6.0 lands.
			const b = fakeClient([{ id: "C" }]);
			b.queue.set("C", [msg("5.0", "C", "replayed?"), msg("6.0", "C", "new")]);
			const t2 = new SlackTransport(b.client, { cursorStore: store, pollIntervalMs: 1 });
			const handler = vi.fn();
			t2.onMessage(handler);
			await t2.connect();
			await settle(40);
			expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ text: "replayed?" }));
			expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: "new" }));
			await t2.disconnect();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps polling after a transient list failure and then delivers", async () => {
		const f = fakeClient([{ id: "C" }]);
		f.setListFails(1);
		f.queue.set("C", [msg("1.0", "C", "after failure")]);
		const t = new SlackTransport(f.client, { pollIntervalMs: 1, backoffMs: 1 });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(60);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ channelId: "C", text: "after failure" }));
		await t.disconnect();
	});

	it("isolates a per-channel failure and still delivers on other channels", async () => {
		const f = fakeClient([{ id: "private" }, { id: "locked" }]);
		f.queue.set("private", [msg("1.0", "private", "ok")]);
		f.queue.set("locked", [msg("2.0", "locked", "hidden")]);
		f.setChannelFails("locked", 1_000_000); // persistent failure
		const logs: string[] = [];
		const t = new SlackTransport(f.client, { pollIntervalMs: 1, logger: (l) => logs.push(l) });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(60);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ channelId: "private", text: "ok" }));
		expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ text: "hidden" }));
		expect(logs.filter((l) => l.includes("slack channel locked poll transient")).length).toBe(1);
		expect(t.isRunning()).toBe(true);
		await t.disconnect();
	});

	it("stops the loop on a fatal invalid_auth (ok:false body)", async () => {
		const f = fakeClient();
		const logs: string[] = [];
		f.setFatal(Object.assign(new Error("invalid_auth"), { status: 400, slackError: "invalid_auth" }));
		const t = new SlackTransport(f.client, { pollIntervalMs: 1, logger: (l) => logs.push(l) });
		await t.connect();
		await settle(40);
		expect(logs.some((l) => l.includes("slack") && l.includes("fatal"))).toBe(true);
		expect(t.isRunning()).toBe(false);
		await t.disconnect();
	});

	it("treats a transient slackError as non-fatal and keeps polling", async () => {
		const f = fakeClient([{ id: "C" }]);
		// One non-fatal, transient ok:false error (e.g. rate_limited), then recover.
		let failed = 1;
		const flaky: SlackClient = {
			...f.client,
			async listChannels() {
				if (failed-- > 0) {
					throw Object.assign(new Error("rate_limited"), { status: 429 });
				}
				return channels();
			},
		};
		f.queue.set("C", [msg("1.0", "C", "recovered")]);
		const logs: string[] = [];
		const t = new SlackTransport(flaky, { pollIntervalMs: 1, backoffMs: 1, logger: (l) => logs.push(l) });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(60);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: "recovered" }));
		expect(t.isRunning()).toBe(true);
		await t.disconnect();
		function channels() {
			return [{ id: "C" }];
		}
	});

	it("disconnect stops the loop and aborts an in-flight history", async () => {
		const f = fakeClient([{ id: "C" }]);
		let aborted = false;
		const clientWithSignal: SlackClient = {
			...f.client,
			async history(input) {
				if (input.signal) input.signal.addEventListener("abort", () => (aborted = true));
				await new Promise((r) => setTimeout(r, 100));
				return [];
			},
		};
		const t = new SlackTransport(clientWithSignal, { pollIntervalMs: 1 });
		await t.connect();
		await t.disconnect();
		expect(aborted).toBe(true);
		expect(t.isRunning()).toBe(false);
	});

	it("warns and keeps polling when the cursor write fails (not fatal, never silent)", async () => {
		const f = fakeClient([{ id: "C" }]);
		f.queue.set("C", [msg("1.0", "C", "hello")]);
		const logs: string[] = [];
		const failingStore = {
			load: () => ({}),
			save: () => {
				throw new Error("disk full");
			},
		};
		const t = new SlackTransport(f.client, {
			pollIntervalMs: 1,
			logger: (l) => logs.push(l),
			cursorStore: failingStore,
		});
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(50);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }));
		expect(logs.some((l) => l.includes("slack cursor write failed"))).toBe(true);
		expect(t.isRunning()).toBe(true);
		await t.disconnect();
	});

	it("skips messages without a user or text", async () => {
		const f = fakeClient([{ id: "C" }]);
		f.queue.set("C", [
			{ ts: "1.0", channel: "C" } as SlackMessage, // no user/text
			{ ts: "2.0", channel: "C", user: "x" } as SlackMessage, // no text
			msg("3.0", "C", "real"),
		]);
		const t = new SlackTransport(f.client, { pollIntervalMs: 1 });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(40);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: "real" }));
		await t.disconnect();
	});
});

describe("cursor stores", () => {
	it("FileSlackCursorStore loads empty when missing and round-trips a saved map", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-sl-file-"));
		try {
			const file = join(dir, "c.json");
			expect(new FileSlackCursorStore(file).load()).toEqual({});
			const s = new FileSlackCursorStore(file);
			s.save({ C: "9.0" });
			expect(new FileSlackCursorStore(file).load()).toEqual({ C: "9.0" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("HttpSlackClient (local server boundary)", () => {
	it("POSTs the right methods with Bearer auth and parses history + channels", async () => {
		const requests: Array<{ url: string; auth?: string; body?: unknown }> = [];
		let server: Server | undefined;
		const port = await new Promise<number>((resolve, reject) => {
			server = createServer((req, res) => {
				let raw = "";
				req.on("data", (c) => (raw += c));
				req.on("end", () => {
					requests.push({
						url: req.url ?? "",
						auth: req.headers.authorization,
						body: raw ? JSON.parse(raw) : undefined,
					});
					res.writeHead(200, { "content-type": "application/json" });
					if (req.url?.includes("chat.postMessage")) {
						res.end(JSON.stringify({ ok: true, ts: "1.0" }));
					} else if (req.url?.includes("conversations.history")) {
						res.end(JSON.stringify({ ok: true, messages: [{ user: "U1", text: "hi", ts: "2.0" }] }));
					} else if (req.url?.includes("conversations.list")) {
						res.end(JSON.stringify({ ok: true, channels: [{ id: "C1" }, { id: "C2" }] }));
					} else {
						res.end(JSON.stringify({ ok: false, error: "method_not_supported" }));
					}
				});
			});
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
		});
		try {
			const client = new HttpSlackClient({ token: "T", baseUrl: `http://127.0.0.1:${port}` });
			await client.postMessage({ channel: "C1", text: "hello" });
			const msgs = await client.history({ channel: "C1", oldest: "1.5" });
			const channels = await client.listChannels();

			const post = requests.find((r) => r.url.includes("chat.postMessage"))!;
			expect(post.auth).toBe("Bearer T");
			expect(post.body).toEqual({ channel: "C1", text: "hello" });
			const hist = requests.find((r) => r.url.includes("conversations.history"))!;
			expect(hist.body).toEqual({ channel: "C1", limit: 100, oldest: "1.5" });
			expect(msgs).toEqual([{ user: "U1", text: "hi", ts: "2.0" }]);
			const list = requests.find((r) => r.url.includes("conversations.list"))!;
			expect(list.body).toEqual({ types: "im,public_channel,private_channel,mpim", limit: 200 });
			expect(channels).toEqual([{ id: "C1" }, { id: "C2" }]);
		} finally {
			if (server) server.close();
		}
	});

	it("surfaces a fatal ok:false invalid_auth so the loop stops", async () => {
		let server: Server | undefined;
		const port = await new Promise<number>((resolve, reject) => {
			server = createServer((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: "invalid_auth" }));
			});
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
		});
		try {
			const client = new HttpSlackClient({ token: "BAD", baseUrl: `http://127.0.0.1:${port}` });
			const logs: string[] = [];
			const t = new SlackTransport(client, { pollIntervalMs: 1, logger: (l) => logs.push(l) });
			await t.connect();
			await settle(60);
			expect(t.isRunning()).toBe(false);
			expect(logs.some((l) => l.includes("fatal"))).toBe(true);
			await t.disconnect();
		} finally {
			if (server) server.close();
		}
	});

	it("classifies the fatal-error set correctly", () => {
		for (const code of FATAL_SLACK_ERRORS) {
			expect(isFatalSlackError(Object.assign(new Error(code), { status: 400, slackError: code }))).toBe(true);
		}
		expect(isFatalSlackError(Object.assign(new Error("rate_limited"), { status: 429 }))).toBe(false);
		expect(isFatalSlackError(Object.assign(new Error("x"), { status: 400, slackError: "channel_not_found" }))).toBe(
			false,
		);
	});
});
