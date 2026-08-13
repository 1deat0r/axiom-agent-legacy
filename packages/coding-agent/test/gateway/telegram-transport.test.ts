import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	chunkTelegramText,
	FileTelegramOffsetStore,
	HttpTelegramClient,
	TELEGRAM_HTTP_TIMEOUT_MS,
	TELEGRAM_LONG_POLL_MAX_SECONDS,
	type TelegramClient,
	TelegramTransport,
	type TelegramUpdate,
	telegramRequestTimeoutMs,
} from "../../src/gateway/transports/telegram.js";

/** A minimal client for transport tests that never need polling. */
class NoopClient implements TelegramClient {
	async sendMessage(): Promise<number> {
		return 0;
	}
	async editMessageText(): Promise<void> {}
	async sendChatAction(): Promise<void> {}
	async getUpdates(): Promise<TelegramUpdate[]> {
		return [];
	}
}

/** An in-memory Telegram client the transport polls (configuration via the returned object). */
function fakeClient(initial: TelegramUpdate[] = []) {
	const sent: Array<{ chatId: string; text: string; messageId?: number; edited?: boolean; action?: string }> = [];
	const offsets: number[] = [];
	const timeouts: Array<number | undefined> = [];
	const queue: TelegramUpdate[] = [...initial];
	let failNext = 0;
	let fatal: Error | undefined;
	let nextId = 100;
	const client: TelegramClient = {
		async sendMessage(input) {
			const id = nextId++;
			sent.push({ chatId: input.chatId, text: input.text, messageId: id });
			return id;
		},
		async editMessageText(input) {
			sent.push({ chatId: input.chatId, text: input.text, messageId: input.messageId, edited: true });
		},
		async sendChatAction(input) {
			sent.push({ chatId: input.chatId, text: `action:${input.action}`, action: input.action });
		},
		async getUpdates(input) {
			if (input.offset !== undefined) offsets.push(input.offset);
			timeouts.push(input.timeout);
			if (fatal) throw fatal;
			if (failNext > 0) {
				failNext--;
				throw Object.assign(new Error("network down"), { status: 502 });
			}
			// Model Telegram's offset semantics: only updates with update_id >= offset come back.
			const from = input.offset ?? 0;
			const batch = queue.filter((u) => u.update_id >= from);
			queue.length = 0;
			return batch;
		},
	};
	return {
		client,
		sent,
		offsets,
		timeouts,
		queue,
		setFailNext(n: number) {
			failNext = n;
		},
		setFatal(e: Error | undefined) {
			fatal = e;
		},
	};
}

function update(id: number, chatId: number, text: string): TelegramUpdate {
	return { update_id: id, message: { message_id: id, chat: { id: chatId, type: "private" }, text } };
}

async function settle(ms = 30) {
	await new Promise((r) => setTimeout(r, ms));
}

/** The ordered word sequence of a chunked send equals the original words (nothing lost, order kept). */
function words(text: string): string[] {
	return text.split(/\s+/).filter((w) => w.length > 0);
}

describe("chunkTelegramText", () => {
	it("leaves short text as a single chunk", () => {
		expect(chunkTelegramText("hello", 4096)).toEqual(["hello"]);
	});
	it("splits long text at the last whitespace at or before the limit", () => {
		const text = `${"a".repeat(4090)} ${"b".repeat(4090)}`;
		const chunks = chunkTelegramText(text, 4096);
		expect(chunks.length).toBe(2);
		expect(chunks.every((c) => c.length <= 4096)).toBe(true);
		expect(chunks[0]!.includes("b")).toBe(false);
		expect(chunks[1]!.includes("a")).toBe(false);
	});
	it("hard-splits at the limit when there is no whitespace within it", () => {
		const text = "x".repeat(9000);
		const chunks = chunkTelegramText(text, 4096);
		expect(chunks.every((c) => c.length <= 4096)).toBe(true);
		expect(chunks.map((c) => c.length)).toEqual([4096, 4096, 808]);
	});
});

describe("TelegramTransport", () => {
	it("sends text to the chat id and chunks long replies in order", async () => {
		const f = fakeClient();
		const t = new TelegramTransport(f.client, { pollIntervalMs: 1 });
		await t.connect();
		await t.send({ channelId: "123", recipient: "123" }, "hi");
		const long = "w ".repeat(4000).trim(); // 7999 chars, well over one chunk
		await t.send({ channelId: "123", recipient: "123" }, long);
		expect(f.sent[0]).toMatchObject({ chatId: "123", text: "hi" });
		const chunks = f.sent.slice(1);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((s) => s.text.length <= 4096)).toBe(true);
		expect(chunks.every((s) => s.chatId === "123")).toBe(true);
		expect(words(chunks.map((s) => s.text).join(" "))).toEqual(words(long));
		await t.disconnect();
	});

	it("delivers a private-chat message with String(chat.id)", async () => {
		const f = fakeClient();
		f.queue.push(update(1, 555, "hello"));
		const t = new TelegramTransport(f.client, { pollIntervalMs: 1 });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(30);
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: "555", sender: "555", text: "hello", isCommand: false }),
		);
		await t.disconnect();
	});

	it("skips updates without text or chat and still acks them", async () => {
		const f = fakeClient();
		f.queue.push(
			{ update_id: 1, message: { chat: { id: 1, type: "private" } } }, // no text
			update(2, 2, "ok"),
			{ update_id: 3 } as TelegramUpdate, // no message
		);
		const t = new TelegramTransport(f.client, { pollIntervalMs: 1 });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(30);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ channelId: "2", text: "ok" }));
		// Next poll passes offset 4 (max(1,2,3)+1) — skipped updates acked too.
		expect(f.offsets.at(-1)).toBe(4);
		await t.disconnect();
	});

	it("acks the batch offset to getUpdates (no replay within a run)", async () => {
		const f = fakeClient();
		f.queue.push(update(5, 1, "a"), update(6, 1, "b"));
		const t = new TelegramTransport(f.client, { pollIntervalMs: 1 });
		t.onMessage(() => {});
		await t.connect();
		await settle(30);
		expect(f.offsets.at(-1)).toBe(7);
		await t.disconnect();
	});

	it("persists the offset and does not replay an already-acked message on resume", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-tg-offset-"));
		try {
			await mkdir(dir, { recursive: true });
			const file = join(dir, "offset.json");
			const store = new FileTelegramOffsetStore(file);
			// Run 1: process update 10 -> persisted next offset = 11.
			const a = fakeClient();
			a.queue.push(update(10, 1, "a"));
			const t1 = new TelegramTransport(a.client, { offsetStore: store, pollIntervalMs: 1 });
			t1.onMessage(() => {});
			await t1.connect();
			await settle(30);
			await t1.disconnect();
			expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ offset: 11 });

			// Run 2: same store resumes at 11, so update 10 (id 10, already acked) must NOT
			// be redelivered even if Telegram re-serves the same chat.
			const b = fakeClient();
			b.queue.push(update(10, 2, "replayed?"));
			const t2 = new TelegramTransport(b.client, { offsetStore: store, pollIntervalMs: 1 });
			const handler = vi.fn();
			t2.onMessage(handler);
			await t2.connect();
			await settle(30);
			expect(handler).not.toHaveBeenCalled();
			expect(b.offsets[0]).toBe(11);
			await t2.disconnect();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps polling after a transient error and then delivers", async () => {
		const f = fakeClient();
		f.setFailNext(1);
		f.queue.push(update(1, 9, "after failure"));
		const t = new TelegramTransport(f.client, { pollIntervalMs: 1, backoffMs: 1 });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(50);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ channelId: "9", text: "after failure" }));
		await t.disconnect();
	});

	it("stops the loop on a fatal error (401 bad token)", async () => {
		const f = fakeClient();
		const logs: string[] = [];
		f.setFatal(Object.assign(new Error("unauthorized"), { status: 401 }));
		const t = new TelegramTransport(f.client, { pollIntervalMs: 1, logger: (l) => logs.push(l) });
		await t.connect();
		await settle(30);
		expect(logs.some((l) => l.includes("telegram"))).toBe(true);
		expect(t.isRunning()).toBe(false);
		const callsBefore = f.offsets.length;
		await settle(20);
		expect(f.offsets.length).toBe(callsBefore);
		await t.disconnect();
	});

	it("disconnect stops the loop and aborts the in-flight getUpdates", async () => {
		const queue: TelegramUpdate[] = [];
		let aborted = false;
		const clientWithSignal: TelegramClient = {
			sendMessage: async () => 1,
			editMessageText: async () => {},
			sendChatAction: async () => {},
			async getUpdates(input) {
				if (input.signal) {
					input.signal.addEventListener("abort", () => {
						aborted = true;
					});
				}
				await new Promise((r) => setTimeout(r, 100));
				return queue.splice(0, queue.length);
			},
		};
		const t = new TelegramTransport(clientWithSignal, { pollIntervalMs: 1 });
		await t.connect();
		await t.disconnect();
		expect(aborted).toBe(true);
		expect(t.isRunning()).toBe(false);
	});

	it("passes the long-poll timeout to getUpdates in seconds, clamped to the API max", async () => {
		const f = fakeClient();
		const t = new TelegramTransport(f.client, { pollIntervalMs: 1, pollTimeoutMs: 30_000 });
		t.onMessage(() => {});
		await t.connect();
		await settle(30);
		// 30000 ms -> 30 s on the wire (the API max is 50 s, a raw 30000 is out of contract).
		expect(f.timeouts[0]).toBe(30);
		await t.disconnect();

		// An over-max ms option is clamped, never sent out of contract.
		const g = fakeClient();
		const t2 = new TelegramTransport(g.client, { pollIntervalMs: 1, pollTimeoutMs: 120_000 });
		t2.onMessage(() => {});
		await t2.connect();
		await settle(30);
		expect(g.timeouts[0]).toBe(TELEGRAM_LONG_POLL_MAX_SECONDS);
		await t2.disconnect();
	});

	it("logs a throttled transient error and keeps polling", async () => {
		const f = fakeClient();
		f.setFailNext(3); // three consecutive transient failures, then success
		f.queue.push(update(1, 7, "recovered"));
		const logs: string[] = [];
		const t = new TelegramTransport(f.client, { pollIntervalMs: 1, backoffMs: 1, logger: (l) => logs.push(l) });
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(60);
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ channelId: "7", text: "recovered" }));
		expect(logs.filter((l) => l.includes("transient")).length).toBe(1); // throttled, not 1-per-retry
		await t.disconnect();
	});

	it("surfaces a failing chunk send and stops the batch (never silent drop)", async () => {
		const f = fakeClient();
		// Make sendMessage fail on the SECOND call only.
		let sendCalls = 0;
		const flaky: TelegramClient = {
			...f.client,
			async sendMessage(input) {
				sendCalls++;
				if (sendCalls === 2) throw new Error("chat deactivated");
				f.sent.push({ chatId: input.chatId, text: input.text });
				return 1;
			},
		};
		const logs: string[] = [];
		const t = new TelegramTransport(flaky, { logger: (l) => logs.push(l) });
		await t.send({ channelId: "123", recipient: "123" }, `${"x".repeat(5000)} ${"y".repeat(5000)}`);
		expect(f.sent.length).toBe(1); // first chunk landed
		expect(logs.some((l) => l.includes("telegram send failed") && l.includes("123"))).toBe(true);
		expect(logs.some((l) => l.includes("chat deactivated"))).toBe(true);
		await t.disconnect();
	});

	it("warns and keeps polling when the offset write fails (not fatal, never silent)", async () => {
		const f = fakeClient();
		f.queue.push(update(1, 1, "hello"));
		const logs: string[] = [];
		const failingStore = {
			load: () => 0,
			save: () => {
				throw new Error("disk full");
			},
		};
		const t = new TelegramTransport(f.client, {
			pollIntervalMs: 1,
			logger: (l) => logs.push(l),
			offsetStore: failingStore,
		});
		const handler = vi.fn();
		t.onMessage(handler);
		await t.connect();
		await settle(40);
		// The message is still delivered and polling continues (the failure is surfaced).
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }));
		expect(logs.some((l) => l.includes("telegram offset write failed"))).toBe(true);
		expect(t.isRunning()).toBe(true);
		await t.disconnect();
	});

	it("passes sendChatAction through to the client for the channel", async () => {
		const f = fakeClient();
		const t = new TelegramTransport(f.client);
		await t.sendChatAction({ channelId: "123", recipient: "123" }, "typing");
		expect(f.sent).toEqual([{ chatId: "123", text: "action:typing", action: "typing" }]);
	});
});

describe("FileTelegramOffsetStore", () => {
	it("loads zero when the file is missing and round-trips a saved offset", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-tg-file-"));
		try {
			const file = join(dir, "o.json");
			expect(new FileTelegramOffsetStore(file).load()).toBe(0);
			const store = new FileTelegramOffsetStore(file);
			store.save(42);
			expect(new FileTelegramOffsetStore(file).load()).toBe(42);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("telegram HTTP timeout bounds", () => {
	it("bounds mutations to the client timeout", () => {
		expect(telegramRequestTimeoutMs("mutate", TELEGRAM_HTTP_TIMEOUT_MS, 50)).toBe(TELEGRAM_HTTP_TIMEOUT_MS);
	});

	it("bounds polls to at least the long-poll window plus grace", () => {
		// 50s long-poll + 5s grace > the 15s mutation timeout, so polls get 55s.
		expect(telegramRequestTimeoutMs("poll", TELEGRAM_HTTP_TIMEOUT_MS, 50)).toBe(55_000);
		// A short long-poll still gets the mutation floor (15s).
		expect(telegramRequestTimeoutMs("poll", TELEGRAM_HTTP_TIMEOUT_MS, 2)).toBe(TELEGRAM_HTTP_TIMEOUT_MS);
	});

	it("aborts a hung sendMessage when the timeout fires", async () => {
		let observedSignal: AbortSignal | undefined;
		const fetchFn: typeof fetch = (async (_input, init) => {
			observedSignal = init?.signal ?? undefined;
			await new Promise<void>((_resolve, reject) => {
				observedSignal?.addEventListener("abort", () => {
					reject(observedSignal?.reason ?? new Error("aborted"));
				});
			});
			throw new Error("unreachable");
		}) as typeof fetch;
		const client = new HttpTelegramClient({ token: "T", timeoutMs: 40, fetchFn });
		const started = Date.now();
		await expect(client.sendMessage({ chatId: "1", text: "hi" })).rejects.toThrow();
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(30); // the signal actually fired
		expect(elapsed).toBeLessThan(1_500); // and it did not wait for a network hang
		expect(observedSignal?.aborted).toBe(true);
	});

	it("aborts a hung editMessageText and sendChatAction the same way", async () => {
		const hang = async (signal: AbortSignal | undefined) => {
			await new Promise<void>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
			});
			throw new Error("unreachable");
		};
		const fetchFn = (async (_input: unknown, init?: RequestInit) => hang(init?.signal ?? undefined)) as typeof fetch;
		const client = new HttpTelegramClient({ token: "T", timeoutMs: 40, fetchFn });
		await expect(client.editMessageText({ chatId: "1", messageId: 7, text: "x" })).rejects.toThrow();
		await expect(client.sendChatAction({ chatId: "1", action: "typing" })).rejects.toThrow();
	});
});

describe("TelegramTransport poll pause (reply delivery)", () => {
	it("aborts the in-flight poll on pause and holds the loop until resume", async () => {
		let pollCount = 0;
		let inFlightSignal: AbortSignal | undefined;
		const releaseFns: Array<() => void> = [];
		const client: TelegramClient = {
			async sendMessage() {
				return 1;
			},
			async editMessageText() {},
			async sendChatAction() {},
			async getUpdates(input) {
				pollCount++;
				inFlightSignal = input.signal;
				// Model the real fetch: resolve only on release, reject on abort.
				await new Promise<void>((resolve, reject) => {
					const onAbort = () => reject(input.signal?.reason ?? new Error("aborted"));
					input.signal?.addEventListener("abort", onAbort);
					releaseFns.push(() => {
						input.signal?.removeEventListener("abort", onAbort);
						resolve();
					});
				});
				return [];
			},
		};
		const t = new TelegramTransport(client, { pollIntervalMs: 1, backoffMs: 1 });
		await t.connect();
		await vi.waitFor(() => expect(pollCount).toBe(1));
		t.pausePolling();
		await vi.waitFor(() => expect(inFlightSignal?.aborted).toBe(true));
		const held = pollCount;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(pollCount).toBe(held); // no new polls while paused
		t.resumePolling();
		await vi.waitFor(() => expect(pollCount).toBe(2));
		for (const release of releaseFns.splice(0)) release();
		await t.disconnect();
	});

	it("resumePolling is a no-op when not paused", () => {
		const t = new TelegramTransport(new NoopClient(), {});
		expect(() => t.resumePolling()).not.toThrow();
	});

	it("disconnect releases a paused loop so the transport can stop", async () => {
		let pollCount = 0;
		const releaseFns: Array<() => void> = [];
		const client: TelegramClient = {
			async sendMessage() {
				return 1;
			},
			async editMessageText() {},
			async sendChatAction() {},
			async getUpdates(input) {
				pollCount++;
				await new Promise<void>((resolve, reject) => {
					const onAbort = () => reject(input.signal?.reason ?? new Error("aborted"));
					input.signal?.addEventListener("abort", onAbort);
					releaseFns.push(() => {
						input.signal?.removeEventListener("abort", onAbort);
						resolve();
					});
				});
				return [];
			},
		};
		const t = new TelegramTransport(client, { pollIntervalMs: 1, backoffMs: 1 });
		await t.connect();
		await vi.waitFor(() => expect(pollCount).toBe(1));
		t.pausePolling();
		await vi.waitFor(() => expect(t.isRunning()).toBe(true));
		await t.disconnect();
		expect(t.isRunning()).toBe(false);
		for (const release of releaseFns.splice(0)) release();
	});
});

describe("HttpTelegramClient (local server boundary)", () => {
	it("POSTs the right method/body and parses the result — never a live bot", async () => {
		const requests: Array<{ url: string; body: unknown }> = [];
		let server: Server | undefined;
		const port = await new Promise<number>((resolve, reject) => {
			server = createServer((req, res) => {
				let raw = "";
				req.on("data", (c) => (raw += c));
				req.on("end", () => {
					requests.push({ url: req.url ?? "", body: JSON.parse(raw || "{}") });
					res.writeHead(200, { "content-type": "application/json" });
					if (req.url?.includes("sendMessage")) {
						res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
					} else {
						res.end(
							JSON.stringify({
								ok: true,
								result: [{ update_id: 9, message: { chat: { id: 42, type: "private" }, text: "hi" } }],
							}),
						);
					}
				});
			});
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
		});
		try {
			const client = new HttpTelegramClient({
				token: "TESTTOKEN",
				baseUrl: `http://127.0.0.1:${port}`,
			});
			await client.sendMessage({ chatId: "42", text: "hello" });
			const updates = await client.getUpdates({ offset: 3, timeout: 5 });

			const paths = requests.map((r) => r.url);
			expect(paths).toContain("/botTESTTOKEN/sendMessage");
			expect(paths).toContain("/botTESTTOKEN/getUpdates");
			const send = requests.find((r) => r.url.includes("sendMessage"))!;
			expect(send.body).toEqual({ chat_id: "42", text: "hello" });
			const up = requests.find((r) => r.url.includes("getUpdates"))!;
			expect(up.body).toEqual({ offset: 3, timeout: 5 });
			expect(updates).toEqual([{ update_id: 9, message: { chat: { id: 42, type: "private" }, text: "hi" } }]);
		} finally {
			if (server) server.close();
		}
	});

	it("POSTs sendChatAction with the chat id and action", async () => {
		const requests: Array<{ url: string; body: unknown }> = [];
		let server: Server | undefined;
		const port = await new Promise<number>((resolve, reject) => {
			server = createServer((req, res) => {
				let raw = "";
				req.on("data", (c) => (raw += c));
				req.on("end", () => {
					requests.push({ url: req.url ?? "", body: JSON.parse(raw || "{}") });
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true, result: true }));
				});
			});
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
		});
		try {
			const client = new HttpTelegramClient({ token: "TESTTOKEN", baseUrl: `http://127.0.0.1:${port}` });
			await client.sendChatAction({ chatId: "42", action: "typing" });
			expect(requests[0]?.url).toBe("/botTESTTOKEN/sendChatAction");
			expect(requests[0]?.body).toEqual({ chat_id: "42", action: "typing" });
		} finally {
			if (server) server.close();
		}
	});

	it("surfaces the Bot API error_code (401 bad token) as fatal so the loop stops", async () => {
		let server: Server | undefined;
		const port = await new Promise<number>((resolve, reject) => {
			server = createServer((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				// An ok:false body with a real error_code — the fatal path.
				res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
			});
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
		});
		try {
			const client = new HttpTelegramClient({
				token: "BADTOKEN",
				baseUrl: `http://127.0.0.1:${port}`,
			});
			const logs: string[] = [];
			const t = new TelegramTransport(client, { pollIntervalMs: 1, logger: (l) => logs.push(l) });
			await t.connect();
			await settle(60);
			// The real client throws status 401 -> isFatalTelegramError stops the loop.
			expect(t.isRunning()).toBe(false);
			expect(logs.some((l) => l.includes("fatal"))).toBe(true);
			await t.disconnect();
		} finally {
			if (server) server.close();
		}
	});
});
