/**
 * Telegram transport (ADR-0017): adapts the Telegram Bot API to the gateway's
 * typed transport contract. Unlike Signal, there is no operator-side linked
 * daemon — a bot talks to api.telegram.org over HTTPS (long-poll getUpdates,
 * sendMessage for outbound). Token-gated; tests inject a fake TelegramClient,
 * and the shipped HttpTelegramClient is exercised against a local server, never
 * a live bot.
 *
 * Security posture: the sender allowlist in the router is the gate (deny
 * unknown chats by default before any model call). channelId = sender =
 * String(chat.id). Private chats are positive ids and are allowlisted by the
 * owner's personal chat id; group/supergroup chats are negative ids that never
 * match a positive-id allowlist, so they are denied by default unless the group
 * id is itself allowlisted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { toGatewayMessage } from "../messages.js";
import type { GatewayMessage, GatewayRecipient, GatewayTransport } from "../types.js";

/** The Telegram Bot API outbound chunk-size cap (sendMessage rejects >4096). */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** The Bot API getUpdates long-poll 'timeout' parameter cap, in seconds. */
export const TELEGRAM_LONG_POLL_MAX_SECONDS = 50;

/**
 * Client-side HTTP timeout for outbound mutations (sendMessage / edit /
 * sendChatAction). A hung connection to api.telegram.org otherwise stalls the
 * gateway's reply path for minutes (observed 2026-08-13: a ~25s hang turned a
 * 3s completion into a 31s reply). The timeout turns the hang into a fast,
 * visible failure — the streaming path falls back to a fresh send, and a
 * still-stuck network surfaces as an ok:false ledger entry instead of silence.
 */
export const TELEGRAM_HTTP_TIMEOUT_MS = 15_000;
/** Grace added to the long-poll window so the poll is never cut mid-flight. */
export const TELEGRAM_LONG_POLL_GRACE_MS = 5_000;

/**
 * The client-side timeout for one Telegram HTTP call: mutations get the
 * operator's timeout; polls get at least the long-poll window plus grace so a
 * 50s long-poll is never aborted early.
 */
export function telegramRequestTimeoutMs(kind: "mutate" | "poll", timeoutMs: number, pollSeconds: number): number {
	if (kind === "mutate") return timeoutMs;
	return Math.max(timeoutMs, pollSeconds * 1000 + TELEGRAM_LONG_POLL_GRACE_MS);
}

/** A hard timeout signal, merged with an optional caller signal. */
function timedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	if (signal === undefined) return AbortSignal.timeout(timeoutMs);
	return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

/** One update from getUpdates (the fields the transport consumes). */
export interface TelegramUpdate {
	update_id: number;
	message?: {
		message_id?: number;
		chat?: { id?: number; type?: string };
		text?: string;
		date?: number;
	};
}

/** The Telegram Bot API boundary (a real client talks HTTPS; tests fake this). */
export interface TelegramClient {
	/** Sends a message and returns its Telegram message_id (for later edits). */
	sendMessage(input: { chatId: string; text: string }): Promise<number>;
	/** Edits an existing message's text in place (streaming, ADR-0004/#6). */
	editMessageText(input: { chatId: string; messageId: number; text: string }): Promise<void>;
	/** Sends a chat action (typing/…) so the peer sees live activity. */
	sendChatAction(input: { chatId: string; action: string }): Promise<void>;
	/**
	 * Long-poll getUpdates. `timeout` is in SECONDS (the Bot API parameter, max
	 * 50) — the transport converts its ms option at this boundary.
	 */
	getUpdates(input: { offset?: number; timeout?: number; signal?: AbortSignal }): Promise<TelegramUpdate[]>;
}

/** Construct options for the real HTTP client. */
export interface HttpTelegramClientOptions {
	token: string;
	/** Defaults to https://api.telegram.org. */
	baseUrl?: string;
	/** Injectable fetch for the local-server test; defaults to global fetch. */
	fetchFn?: typeof fetch;
	/** Client-side HTTP timeout for mutations; defaults to TELEGRAM_HTTP_TIMEOUT_MS. */
	timeoutMs?: number;
}

/**
 * Split Telegram-bound text into ≤limit segments: split at the last whitespace
 * at or before the limit when one exists (avoids mid-word breaks), else hard-
 * split at the limit so a giant unbroken token is never rejected wholesale.
 */
export function chunkTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
	if (text.length <= limit) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const window = rest.slice(0, limit);
		const ws = window.lastIndexOf(" ");
		const splitAt = ws > 0 ? ws : limit;
		chunks.push(rest.slice(0, splitAt));
		rest = rest.slice(splitAt);
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}

/** Persists the acknowledged getUpdates offset so restarts do not replay. */
export interface TelegramOffsetStore {
	load(): number;
	save(offset: number): void;
}

/** In-memory offset (no persistence) — the safe default for tests. */
export class NoopTelegramOffsetStore implements TelegramOffsetStore {
	private value = 0;
	load(): number {
		return this.value;
	}
	save(offset: number): void {
		this.value = offset;
	}
}

/** Json-offset store under the gateway dir (single writer, best-effort). */
export class FileTelegramOffsetStore implements TelegramOffsetStore {
	constructor(private readonly path: string) {}
	load(): number {
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as { offset?: number };
			return typeof raw.offset === "number" ? raw.offset : 0;
		} catch {
			return 0;
		}
	}
	save(offset: number): void {
		writeFileSync(this.path, JSON.stringify({ offset }), "utf8");
	}
}

export interface TelegramTransportOptions {
	/** Long-poll timeout passed to getUpdates (Bot API max 50s). */
	pollTimeoutMs?: number;
	/** Pause between polls when the client returns immediately (tests use 1ms). */
	pollIntervalMs?: number;
	/** Backoff after a transient poll failure. */
	backoffMs?: number;
	/** Offset store; defaults to in-memory. */
	offsetStore?: TelegramOffsetStore;
	/** Stderr/observability sink; defaults to console.error. */
	logger?: (line: string) => void;
}

/** A fatal, non-transient getUpdates rejection (bad token / conflicting poll). */
export function isFatalTelegramError(error: unknown): boolean {
	const status = (error as { status?: number }).status;
	return status === 401 || status === 409;
}

/** Polling GatewayTransport over the Telegram Bot API. */
export class TelegramTransport implements GatewayTransport {
	private readonly client: TelegramClient;
	private readonly timeoutMs: number;
	private readonly intervalMs: number;
	private readonly backoffMs: number;
	private readonly offsetStore: TelegramOffsetStore;
	private readonly logger: (line: string) => void;
	private nextOffset = 0;
	private handler: ((msg: GatewayMessage) => void) | undefined;
	private stopped = false;
	private controller: AbortController | undefined;
	private running = false;
	private lastTransientLogged: string | undefined;
	/** True while the gateway delivers a reply: the poll loop must hold. */
	private paused = false;
	private pollResumeWaiters: Array<() => void> = [];

	constructor(client: TelegramClient, options: TelegramTransportOptions = {}) {
		this.client = client;
		this.timeoutMs = options.pollTimeoutMs ?? 30_000;
		this.intervalMs = options.pollIntervalMs ?? 0;
		this.backoffMs = options.backoffMs ?? 1_000;
		this.offsetStore = options.offsetStore ?? new NoopTelegramOffsetStore();
		this.logger = options.logger ?? ((line) => console.error(line));
		this.nextOffset = this.offsetStore.load();
	}

	connect(): Promise<void> {
		if (this.running) return Promise.resolve();
		this.stopped = false;
		this.running = true;
		void this.loop();
		return Promise.resolve();
	}

	disconnect(): Promise<void> {
		this.stopped = true;
		this.running = false;
		// Wake a paused loop so it observes `stopped` and exits cleanly.
		this.resumePolling();
		this.controller?.abort();
		this.controller = undefined;
		return Promise.resolve();
	}

	/** Test introspection: whether the poll loop is currently running. */
	isRunning(): boolean {
		return this.running;
	}

	onMessage(handler: (msg: GatewayMessage) => void): void {
		this.handler = handler;
	}

	/**
	 * Hold the poll loop while a reply is delivered (ADR-0039): Telegram
	 * queues outbound calls behind an open getUpdates long-poll, so a
	 * streamed edit can hang until the poll window expires (observed
	 * 2026-08-13: every single-message reply took ~30s — exactly the poll
	 * window — with edits timing out at 15s). Pausing aborts the in-flight
	 * poll and keeps the loop idle until resume.
	 */
	pausePolling(): void {
		if (this.paused) return;
		this.paused = true;
		this.controller?.abort();
	}

	resumePolling(): void {
		if (!this.paused) return;
		this.paused = false;
		const waiters = this.pollResumeWaiters.splice(0);
		for (const resolve of waiters) resolve();
	}

	private waitForPollResume(): Promise<void> {
		return new Promise((resolve) => {
			this.pollResumeWaiters.push(resolve);
		});
	}

	/** Single-message send that returns the message id (for streaming edits). */
	async sendMessage(to: GatewayRecipient, text: string): Promise<number> {
		return this.client.sendMessage({ chatId: to.channelId, text });
	}

	/** Edit a previously-sent message in place (throws on failure -> caller falls back). */
	async editMessage(chatId: string, messageId: number, text: string): Promise<void> {
		await this.client.editMessageText({ chatId, messageId, text });
	}

	/** Ping a chat action (typing) so the peer sees the gateway is alive. */
	async sendChatAction(to: GatewayRecipient, action: string): Promise<void> {
		await this.client.sendChatAction({ chatId: to.channelId, action });
	}

	async send(to: GatewayRecipient, text: string): Promise<void> {
		const chunks = chunkTelegramText(text, TELEGRAM_TEXT_LIMIT);
		for (const chunk of chunks) {
			try {
				await this.client.sendMessage({ chatId: to.channelId, text: chunk });
			} catch (error) {
				// Surface the failure (operator's observable) and stop this batch —
				// never append silently dropped text.
				const message = error instanceof Error ? error.message : String(error);
				this.logger(`telegram send failed (chat ${to.channelId}): ${message}`);
				break;
			}
		}
	}

	private async loop(): Promise<void> {
		while (!this.stopped) {
			if (this.paused) {
				await this.waitForPollResume();
				continue;
			}
			this.controller = new AbortController();
			try {
				await this.pollOnce(this.controller.signal);
				if (this.stopped) break;
			} catch (error) {
				if (this.stopped) break;
				if (this.paused) continue; // the pause aborted the in-flight poll — silent
				if (isFatalTelegramError(error)) {
					const message = error instanceof Error ? error.message : String(error);
					this.logger(`telegram polling stopped (fatal): ${message}`);
					this.stopped = true;
					this.running = false;
					break;
				}
				// Transient (network/5xx): keep polling from the same offset after a
				// backoff. Emit a throttled line so a stuck network / 5xx storm is
				// visible to the operator without spamming one line per backoff.
				const message = error instanceof Error ? error.message : String(error);
				if (message !== this.lastTransientLogged) {
					this.lastTransientLogged = message;
					this.logger(`telegram polling transient: ${message}`);
				}
				await new Promise((r) => setTimeout(r, this.backoffMs));
				continue;
			}
			if (this.intervalMs > 0) await new Promise((r) => setTimeout(r, this.intervalMs));
		}
	}

	private async pollOnce(signal?: AbortSignal): Promise<void> {
		// The Bot API getUpdates 'timeout' parameter is seconds (max
		// TELEGRAM_LONG_POLL_MAX_SECONDS); the transport option is ms, so convert
		// at the boundary and clamp so an out-of-contract value never goes on the
		// wire (an over-max 400 would otherwise loop silently as a transient).
		const timeoutSeconds = Math.min(TELEGRAM_LONG_POLL_MAX_SECONDS, Math.ceil(this.timeoutMs / 1000));
		const updates = await this.client.getUpdates({
			offset: this.nextOffset,
			timeout: timeoutSeconds,
			signal,
		});
		let maxId = this.nextOffset;
		for (const u of updates) {
			if (u.update_id >= maxId) maxId = u.update_id + 1;
			this.deliver(u);
		}
		this.nextOffset = maxId;
		try {
			this.offsetStore.save(maxId);
		} catch (error) {
			// A failed offset write would replay duplicate agent runs after a
			// restart — surface it, never silently degrade into transient-retry.
			const message = error instanceof Error ? error.message : String(error);
			this.logger(`telegram offset write failed: ${message}`);
		}
	}

	private deliver(u: TelegramUpdate): void {
		if (!this.handler) return;
		const msg = u.message;
		if (!msg) return;
		const chatId = msg.chat?.id;
		const text = msg.text;
		if (chatId === undefined || text === undefined || text === "") return;
		const id = String(chatId);
		this.handler(
			toGatewayMessage({
				channelId: id,
				sender: id,
				text,
				timestamp: msg.date !== undefined ? msg.date * 1000 : undefined,
			}),
		);
	}
}

/** Real TelegramClient backed by fetch to api.telegram.org. */
export class HttpTelegramClient implements TelegramClient {
	private readonly token: string;
	private readonly baseUrl: string;
	private readonly fetchFn: typeof fetch;
	private readonly timeoutMs: number;

	constructor(options: HttpTelegramClientOptions) {
		this.token = options.token;
		this.baseUrl = (options.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
		this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
		this.timeoutMs = options.timeoutMs ?? TELEGRAM_HTTP_TIMEOUT_MS;
	}

	private url(method: string): string {
		return `${this.baseUrl}/bot${this.token}/${method}`;
	}

	async sendMessage(input: { chatId: string; text: string }): Promise<number> {
		const data = await this.post(
			"sendMessage",
			{ chat_id: input.chatId, text: input.text },
			undefined,
			this.timeoutMs,
		);
		const result = data.result as { message_id?: number } | undefined;
		return typeof result?.message_id === "number" ? result.message_id : 0;
	}

	async editMessageText(input: { chatId: string; messageId: number; text: string }): Promise<void> {
		await this.post(
			"editMessageText",
			{ chat_id: input.chatId, message_id: input.messageId, text: input.text },
			undefined,
			this.timeoutMs,
		);
	}

	async sendChatAction(input: { chatId: string; action: string }): Promise<void> {
		await this.post("sendChatAction", { chat_id: input.chatId, action: input.action }, undefined, this.timeoutMs);
	}

	async getUpdates(input: { offset?: number; timeout?: number; signal?: AbortSignal }): Promise<TelegramUpdate[]> {
		const pollSeconds = Math.min(TELEGRAM_LONG_POLL_MAX_SECONDS, Math.max(1, input.timeout ?? 1));
		const data = await this.post(
			"getUpdates",
			{ offset: input.offset, timeout: input.timeout },
			timedSignal(telegramRequestTimeoutMs("poll", this.timeoutMs, pollSeconds), input.signal),
			undefined,
		);
		const result = data.result;
		return Array.isArray(result) ? (result as TelegramUpdate[]) : [];
	}

	private async post(
		method: string,
		body: Record<string, unknown>,
		signal?: AbortSignal,
		requestTimeoutMs?: number,
	): Promise<{ ok: boolean; result?: unknown; description?: string; error_code?: number }> {
		const res = await this.fetchFn(this.url(method), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: requestTimeoutMs !== undefined ? timedSignal(requestTimeoutMs, signal) : signal,
		});
		if (!res.ok) {
			throw Object.assign(new Error(`telegram ${method} HTTP ${res.status}`), { status: res.status });
		}
		const data = (await res.json()) as {
			ok: boolean;
			result?: unknown;
			description?: string;
			error_code?: number;
		};
		if (data.ok !== true) {
			// Use the Bot API error_code (401 bad token / 409 conflicting poll are
			// FATAL, not transient) so isFatalTelegramError can classify correctly.
			const status = data.error_code ?? 400;
			throw Object.assign(
				new Error(`telegram ${method} rejected: ${data.description ?? data.error_code ?? "unknown"}`),
				{ status },
			);
		}
		return data;
	}
}
