import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	chunkDiscordText,
	DISCORD_TEXT_LIMIT,
	type DiscordChannel,
	type DiscordClient,
	type DiscordMessage,
	DiscordTransport,
	FileDiscordCursorStore,
	HttpDiscordClient,
	MapDiscordCursorStore,
} from "../../src/gateway/transports/discord.js";

/** An in-memory Discord client. `queue` holds undelivered messages per channel. */
function fakeClient(channels: DiscordChannel[] = []) {
	const sent: Array<{ channelId: string; content: string }> = [];
	const queue = new Map<string, DiscordMessage[]>();
	const afterCalls: Array<string | undefined> = [];
	let listFails = 0;
	const channelFails = new Map<string, number>();
	let fatal: Error | undefined;
	const client: DiscordClient = {
		async sendMessage(input) {
			sent.push({ channelId: input.channelId, content: input.content });
		},
		async listChannels() {
			if (fatal) throw fatal;
			if (listFails > 0) {
				listFails--;
				throw Object.assign(new Error("network down"), { status: 502 });
			}
			return channels;
		},
		async getMessages(input) {
			afterCalls.push(input.after);
			if (fatal) throw fatal;
			const remaining = channelFails.get(input.channelId) ?? 0;
			if (remaining > 0) {
				channelFails.set(input.channelId, remaining - 1);
				throw Object.assign(new Error("no access"), { status: 403 });
			}
			const all = queue.get(input.channelId) ?? [];
			// Discord model: only messages with id > `after` are returned.
			const batch = input.after === undefined ? all : all.filter((m) => m.id > input.after!);
			return batch;
		},
	};
	return {
		client,
		sent,
		afterCalls,
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

function msg(id: string, channelId: string, content: string, authorId = "owner"): DiscordMessage {
	return { id, channel_id: channelId, author: { id: authorId }, content, timestamp: "2026-08-12T00:00:00.000Z" };
}

async function settle(ms = 30) {
	await new Promise((r) => setTimeout(r, ms));
}

/** The ordered word sequence of a chunked send equals the original words (nothing lost, order kept). */
function words(text: string): string[] {
	return text.split(/\s+/).filter((w) => w.length > 0);
}

describe("chunkDiscordText", () => {
	it("leaves short text as a single chunk", () => {
		expect(chunkDiscordText("hello")).toEqual(["hello"]);
	});
	it("splits at the 2000-char Discord cap at the last whitespace at or before it", () => {
		const text = `${"a".repeat(1995)} ${"b".repeat(1995)}`;
		const chunks = chunkDiscordText(text);
		expect(chunks.length).toBe(2);
		expect(chunks.every((c) => c.length <= DISCORD_TEXT_LIMIT)).toBe(true);
		expect(chunks[0]!.includes("b")).toBe(false);
	});
	it("hard-splits an unbroken token at the cap", () => {
		const chunks = chunkDiscordText("x".repeat(5000));
		expect(chunks.every((c) => c.length <= DISCORD_TEXT_LIMIT)).toBe(true);
		expect(chunks.map((c) => c.length)).toEqual([2000, 2000, 1000]);
	});
});

describe("DiscordTransport", () => {
	it("sends text to the channel id and chunks long replies in order", async () => {
		const f = fakeClient();
		const t = new DiscordTransport(f.client, { pollIntervalMs: 1 });
		await t.connect();
		await t.send({ channelId: "111", recipient: "owner" }, "hi");
		const long = "w ".repeat(1500).trim(); // 2999 chars, over one 2000 chunk
		await t.send({ channelId: "111", recipient: "owner" }, long);
		expect(f.sent[0]).toEqual({ channelId: "111", content: "hi" });
		const chunks = f.sent.slice(1);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((s) => s.content.length <= DISCORD_TEXT_LIMIT)).toBe(true);
		expect(chunks.every((s) => s.channelId === "111")).toBe(true);
		expect(words(chunks.map((s) => s.content).join(" "))).toEqual(words(long));
		await t.disconnect();
	});

	it("delivers a DM message with channel id + author id", async () => {
		const f = fakeClient([{ id: "dm-1", type: 1 }]);
		f.queue.set("dm-1", [msg("100", "dm-1", "hello")]);
		const t = new DiscordTransport(f.client, { pollIntervalMs: 1 });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(40);
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: "dm-1", sender: "owner", text: "hello", isCommand: false }),
		);
		await t.disconnect();
	});

	it("advances the per-channel cursor so already-delivered messages are not redelivered within a run", async () => {
		const f = fakeClient([{ id: "c", type: 0 }]);
		f.queue.set("c", [msg("101", "c", "a"), msg("102", "c", "b")]);
		const t = new DiscordTransport(f.client, { pollIntervalMs: 1 });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(40);
		expect(handler).toHaveBeenCalledTimes(2);
		// Next poll goes in with after=102 (the newest id) and finds nothing new.
		expect(f.afterCalls.some((a) => a === "102")).toBe(true);
		await settle(30);
		expect(handler).toHaveBeenCalledTimes(2);
		await t.disconnect();
	});

	it("persists cursors and does not replay an already-acked message on resume", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-dc-cursor-"));
		try {
			await mkdir(dir, { recursive: true });
			const file = join(dir, "cursors.json");
			const store = new FileDiscordCursorStore(file);
			// Run 1: deliver message 500 on channel c -> cursor persisted as 500.
			const a = fakeClient([{ id: "c", type: 0 }]);
			a.queue.set("c", [msg("500", "c", "a")]);
			const t1 = new DiscordTransport(a.client, { cursorStore: store, pollIntervalMs: 1 });
			t1.onMessage(() => {});
			await t1.connect();
			await settle(40);
			await t1.disconnect();
			expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ c: "500" });

			// Run 2: same store resumes at 500, so message 500 must NOT be redelivered
			// even if the channel still serves it.
			const b = fakeClient([{ id: "c", type: 0 }]);
			b.queue.set("c", [msg("500", "c", "replayed?")]);
			const t2 = new DiscordTransport(b.client, { cursorStore: store, pollIntervalMs: 1 });
			const handler = vi.fn();
			t2.onMessage(handler);
			await t2.connect();
			await settle(40);
			expect(handler).not.toHaveBeenCalled();
			expect(b.afterCalls.some((a) => a === "500")).toBe(true);
			await t2.disconnect();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps polling after a transient list failure and then delivers", async () => {
		const f = fakeClient([{ id: "c", type: 0 }]);
		f.setListFails(1);
		f.queue.set("c", [msg("1", "c", "after failure")]);
		const t = new DiscordTransport(f.client, { pollIntervalMs: 1, backoffMs: 1 });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(60);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ channelId: "c", text: "after failure" }));
		await t.disconnect();
	});

	it("isolates a per-channel failure and still delivers on other channels", async () => {
		const f = fakeClient([
			{ id: "private", type: 0 },
			{ id: "locked", type: 0 },
		]);
		f.queue.set("private", [msg("1", "private", "ok")]);
		f.queue.set("locked", [msg("2", "locked", "hidden")]);
		f.setChannelFails("locked", 1_000_000); // effectively permanent 403 across cycles
		const logs: string[] = [];
		const t = new DiscordTransport(f.client, { pollIntervalMs: 1, logger: (l) => logs.push(l) });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(60);
		// The accessible channel's message lands; the locked channel's 403 is logged
		// and does not take down the accessible channel or the loop.
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ channelId: "private", text: "ok" }));
		expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ text: "hidden" }));
		// Throttled: one line for the persistent 403 across cycles, not one per poll.
		expect(logs.filter((l) => l.includes("discord channel locked poll transient")).length).toBe(1);
		expect(t.isRunning()).toBe(true);
		await t.disconnect();
	});

	it("stops the loop on a fatal 401 (bad token)", async () => {
		const f = fakeClient();
		const logs: string[] = [];
		f.setFatal(Object.assign(new Error("unauthorized"), { status: 401 }));
		const t = new DiscordTransport(f.client, { pollIntervalMs: 1, logger: (l) => logs.push(l) });
		await t.connect();
		await settle(30);
		expect(logs.some((l) => l.includes("discord") && l.includes("fatal"))).toBe(true);
		expect(t.isRunning()).toBe(false);
		await settle(30);
		expect(t.isRunning()).toBe(false);
		await t.disconnect();
	});

	it("disconnect stops the loop and aborts an in-flight getMessages", async () => {
		const f = fakeClient([{ id: "c", type: 0 }]);
		let aborted = false;
		const clientWithSignal: DiscordClient = {
			...f.client,
			async getMessages(input) {
				if (input.signal) {
					input.signal.addEventListener("abort", () => {
						aborted = true;
					});
				}
				await new Promise((r) => setTimeout(r, 100));
				return [];
			},
		};
		const t = new DiscordTransport(clientWithSignal, { pollIntervalMs: 1 });
		await t.connect();
		await t.disconnect();
		expect(aborted).toBe(true);
		expect(t.isRunning()).toBe(false);
	});

	it("warns and keeps polling when the cursor write fails (not fatal, never silent)", async () => {
		const f = fakeClient([{ id: "c", type: 0 }]);
		f.queue.set("c", [msg("1", "c", "hello")]);
		const logs: string[] = [];
		const failingStore = {
			load: () => ({}),
			save: () => {
				throw new Error("disk full");
			},
		};
		const t = new DiscordTransport(f.client, {
			pollIntervalMs: 1,
			logger: (l) => logs.push(l),
			cursorStore: failingStore,
		});
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(50);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }));
		expect(logs.some((l) => l.includes("discord cursor write failed"))).toBe(true);
		expect(t.isRunning()).toBe(true);
		await t.disconnect();
	});

	it("skips messages without an author or content", async () => {
		const f = fakeClient([{ id: "c", type: 0 }]);
		f.queue.set("c", [
			{ id: "1", channel_id: "c" } as DiscordMessage, // no author/content
			{ id: "2", channel_id: "c", author: { id: "x" } } as DiscordMessage, // no content
			msg("3", "c", "real"),
		]);
		const t = new DiscordTransport(f.client, { pollIntervalMs: 1 });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(40);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: "real" }));
		// Cursor still advances past the newest id (3) so skipped messages do not replay.
		expect(f.afterCalls.some((a) => a === "3")).toBe(true);
		await t.disconnect();
	});
});

describe("cursor stores", () => {
	it("MapDiscordCursorStore round-trips via load/save", () => {
		const s = new MapDiscordCursorStore();
		expect(s.load()).toEqual({});
		s.save({ c: "9" });
		expect(s.load()).toEqual({ c: "9" });
	});

	it("FileDiscordCursorStore loads empty when missing and round-trips a saved map", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-dc-file-"));
		try {
			const file = join(dir, "c.json");
			expect(new FileDiscordCursorStore(file).load()).toEqual({});
			const store = new FileDiscordCursorStore(file);
			store.save({ a: "1", b: "2" });
			expect(new FileDiscordCursorStore(file).load()).toEqual({ a: "1", b: "2" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("HttpDiscordClient (local server boundary)", () => {
	it("hits the right routes with Bot auth, sends the body, and parses getMessages", async () => {
		const requests: Array<{ url: string; method: string; auth?: string; body?: unknown }> = [];
		let server: Server | undefined;
		const port = await new Promise<number>((resolve, reject) => {
			server = createServer((req, res) => {
				let raw = "";
				req.on("data", (c) => (raw += c));
				req.on("end", () => {
					requests.push({
						url: req.url ?? "",
						method: req.method ?? "GET",
						auth: req.headers.authorization,
						body: raw ? JSON.parse(raw) : undefined,
					});
					res.writeHead(200, { "content-type": "application/json" });
					if (req.method === "POST") {
						res.end(JSON.stringify({ id: "9" })); // created message
					} else if (req.url?.startsWith("/channels/")) {
						res.end(JSON.stringify([{ id: "2", channel_id: "c", author: { id: "o" }, content: "hi" }]));
					} else if (req.url === "/users/@me/channels") {
						res.end(
							JSON.stringify([
								{ id: "dm", type: 1 },
								{ id: "voice", type: 2 },
							]),
						);
					} else if (req.url === "/users/@me/guilds") {
						res.end(JSON.stringify([{ id: "g1" }]));
					} else if (req.url === "/guilds/g1/channels") {
						res.end(
							JSON.stringify([
								{ id: "text", type: 0 },
								{ id: "cat", type: 4 },
							]),
						);
					} else {
						res.end("[]");
					}
				});
			});
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
		});
		try {
			const client = new HttpDiscordClient({ token: "T", baseUrl: `http://127.0.0.1:${port}` });
			await client.sendMessage({ channelId: "c", content: "hello" });
			const msgs = await client.getMessages({ channelId: "c", after: "5" });
			const channels = await client.listChannels();

			const send = requests.find((r) => r.url === "/channels/c/messages" && r.method === "POST")!;
			expect(send.auth).toBe("Bot T");
			expect(send.body).toEqual({ content: "hello" });
			const get = requests.find((r) => r.url === "/channels/c/messages?after=5")!;
			expect(get.auth).toBe("Bot T");
			expect(msgs).toEqual([{ id: "2", channel_id: "c", author: { id: "o" }, content: "hi" }]);

			// listChannels: DMs (type 1, not 2 voice) + guild text (type 0, not 4 category).
			expect(channels).toEqual([
				{ id: "dm", type: 1 },
				{ id: "text", type: 0 },
			]);
			expect(requests.some((r) => r.url === "/users/@me/channels")).toBe(true);
			expect(requests.some((r) => r.url === "/guilds/g1/channels")).toBe(true);
		} finally {
			if (server) server.close();
		}
	});

	it("surfaces the HTTP status (401 bad token) as fatal so the loop stops", async () => {
		let server: Server | undefined;
		const port = await new Promise<number>((resolve, reject) => {
			server = createServer((_req, res) => {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ message: "401: Unauthorized" }));
			});
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
		});
		try {
			const client = new HttpDiscordClient({ token: "BAD", baseUrl: `http://127.0.0.1:${port}` });
			const logs: string[] = [];
			const t = new DiscordTransport(client, { pollIntervalMs: 1, logger: (l) => logs.push(l) });
			await t.connect();
			await settle(60);
			expect(t.isRunning()).toBe(false);
			expect(logs.some((l) => l.includes("fatal"))).toBe(true);
			await t.disconnect();
		} finally {
			if (server) server.close();
		}
	});
});
