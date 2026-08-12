/**
 * Discord transport (ADR-0020): adapts the Discord Bot API to the gateway's
 * typed transport contract, reusing the Telegram transport's shape (ADR-0017).
 * Like Telegram there is no operator-side linked daemon — a bot talks to
 * api.discord.com over HTTPS with a Bot token. Receiving is REST long-poll:
 * each poll lists the message-capable channels the bot can see (DM + guild
 * text/news) and pulls `GET /channels/{id}/messages?after=<cursor>` past the
 * last delivered snowflake (mirrors Telegram's getUpdates offset). Tests inject
 * a fake DiscordClient; HttpDiscordClient is exercised against a local server,
 * never a live bot.
 *
 * Security posture: the sender allowlist in the router is the gate (deny
 * unknown senders before any model call). channelId = the Discord channel id;
 * sender = the message author id (a snowflake, string). DM/sender identities
 * are gated by the shared config.json allowlist exactly as Telegram's sender
 * gate; a non-allowlisted author anywhere the bot can hear gets the same canned
 * deny the router sends every denial.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { toGatewayMessage } from "../messages.js";
import type { GatewayMessage, GatewayRecipient, GatewayTransport } from "../types.js";
import { chunkTelegramText } from "./telegram.js";

/** The Discord message-content cap (create message rejects >2000). */
export const DISCORD_TEXT_LIMIT = 2000;

/** Channel types where users can post messages a bot sees (GUILD_TEXT, DM, GROUP_DM, NEWS). */
export const DISCORD_TEXT_CHANNEL_TYPES = new Set<number>([0, 1, 3, 5]);

/** One message from GET /channels/{id}/messages (the fields the transport consumes). */
export interface DiscordMessage {
	/** Message snowflake (the receive cursor). */
	id: string;
	channel_id: string;
	author?: { id?: string };
	content?: string;
	/** ISO-8601 timestamp. */
	timestamp?: string;
}

/** A channel the bot can see (only the transport-relevant fields). */
export interface DiscordChannel {
	id: string;
	type?: number;
}

/** The Discord Bot API boundary (a real client talks HTTPS; tests fake this). */
export interface DiscordClient {
	sendMessage(input: { channelId: string; content: string }): Promise<void>;
	/** All message-capable channels the bot can see (DM + guild text/news). */
	listChannels(): Promise<DiscordChannel[]>;
	/** Messages past `after` (snowflake cursor) on one channel; newest last. */
	getMessages(input: { channelId: string; after?: string; signal?: AbortSignal }): Promise<DiscordMessage[]>;
}

/** Construct options for the real HTTP client. */
export interface HttpDiscordClientOptions {
	token: string;
	/** Defaults to https://discord.com/api/v10. */
	baseUrl?: string;
	/** Injectable fetch for the local-server test; defaults to global fetch. */
	fetchFn?: typeof fetch;
}

/**
 * Discord's 2000-char cap is even tighter than Telegram's 4096, but the split
 * rule is identical (last whitespace at or before the limit, hard-split
 * fallback), so we reuse the channel-agnostic chunker rather than duplicating
 * it. Named `chunkDiscordText` here so callers read Discord-shaped.
 */
export function chunkDiscordText(text: string, limit = DISCORD_TEXT_LIMIT): string[] {
	return chunkTelegramText(text, limit);
}

/** Persists the per-channel receive cursor so restarts do not replay messages. */
export interface DiscordCursorStore {
	load(): Record<string, string>;
	save(cursors: Record<string, string>): void;
}

/** In-memory cursor store (no persistence) — the safe default for tests. */
export class MapDiscordCursorStore implements DiscordCursorStore {
	private map = new Map<string, string>();
	load(): Record<string, string> {
		return Object.fromEntries(this.map);
	}
	save(cursors: Record<string, string>): void {
		this.map = new Map(Object.entries(cursors));
	}
}

/** Json cursor store under the gateway dir (single writer, best-effort). */
export class FileDiscordCursorStore implements DiscordCursorStore {
	constructor(private readonly path: string) {}
	load(): Record<string, string> {
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>;
			return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
		} catch {
			return {};
		}
	}
	save(cursors: Record<string, string>): void {
		writeFileSync(this.path, JSON.stringify(cursors, null, 2), "utf8");
	}
}

export interface DiscordTransportOptions {
	/** Pause between poll cycles (REST polling has no long-poll; unlike Telegram). */
	pollIntervalMs?: number;
	/** Backoff after a transient poll failure. */
	backoffMs?: number;
	/** Cursor store; defaults to in-memory. */
	cursorStore?: DiscordCursorStore;
	/** Stderr/observability sink; defaults to console.error. */
	logger?: (line: string) => void;
}

/** A fatal, non-transient Discord rejection (bad bot token). */
export function isFatalDiscordError(error: unknown): boolean {
	const status = (error as { status?: number }).status;
	return status === 401;
}

/**
 * Polling GatewayTransport over the Discord Bot API. Unlike Telegram's
 * single-offset getUpdates, Discord returns per-channel message lists, so the
 * transport keeps a per-channel snowflake cursor, delivers one poll cycle's
 * new messages, and advances each channel past the newest id. A channel whose
 * GET fails (403 no access, 429 rate-limit) is logged and skipped so delivery
 * on every other channel continues; only a 401 (bad token, any route) stops
 * the loop.
 */
export class DiscordTransport implements GatewayTransport {
	private readonly client: DiscordClient;
	private readonly intervalMs: number;
	private readonly backoffMs: number;
	private readonly cursorStore: DiscordCursorStore;
	private readonly logger: (line: string) => void;
	private readonly cursors = new Map<string, string>();
	private handler: ((msg: GatewayMessage) => void) | undefined;
	private stopped = false;
	private controller: AbortController | undefined;
	private running = false;
	private lastTransientLogged: string | undefined;

	constructor(client: DiscordClient, options: DiscordTransportOptions = {}) {
		this.client = client;
		this.intervalMs = options.pollIntervalMs ?? 2_000;
		this.backoffMs = options.backoffMs ?? 1_000;
		this.cursorStore = options.cursorStore ?? new MapDiscordCursorStore();
		this.logger = options.logger ?? ((line) => console.error(line));
		for (const [channelId, cursor] of Object.entries(this.cursorStore.load())) this.cursors.set(channelId, cursor);
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

	async send(to: GatewayRecipient, text: string): Promise<void> {
		const chunks = chunkDiscordText(text, DISCORD_TEXT_LIMIT);
		// Send each ≤2000-char chunk in order; a failing chunk is surfaced to the
		// operator's observable and stops that batch — never silently dropped.
		for (const chunk of chunks) {
			try {
				await this.client.sendMessage({ channelId: to.channelId, content: chunk });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger(`discord send failed (channel ${to.channelId}): ${message}`);
				break;
			}
		}
	}

	private async loop(): Promise<void> {
		while (!this.stopped) {
			this.controller = new AbortController();
			try {
				await this.pollOnce(this.controller.signal);
				if (this.stopped) break;
			} catch (error) {
				if (this.stopped) break;
				if (isFatalDiscordError(error)) {
					const message = error instanceof Error ? error.message : String(error);
					this.logger(`discord polling stopped (fatal): ${message}`);
					this.stopped = true;
					this.running = false;
					break;
				}
				// Transient (network/5xx/list failure): keep polling after a backoff.
				// Emit one throttled line per distinct error, never one per retry.
				const message = error instanceof Error ? error.message : String(error);
				if (message !== this.lastTransientLogged) {
					this.lastTransientLogged = message;
					this.logger(`discord polling transient: ${message}`);
				}
				await new Promise((r) => setTimeout(r, this.backoffMs));
				continue;
			}
			if (this.intervalMs > 0) await new Promise((r) => setTimeout(r, this.intervalMs));
		}
	}

	private async pollOnce(signal?: AbortSignal): Promise<void> {
		const channels = await this.client.listChannels();
		for (const channel of channels) {
			try {
				const after = this.cursors.get(channel.id);
				const messages = await this.client.getMessages({ channelId: channel.id, after, signal });
				let max = after;
				for (const m of messages) {
					if (max === undefined || m.id > max) max = m.id;
					this.deliver(channel.id, m);
				}
				if (max !== undefined && max !== after) this.cursors.set(channel.id, max);
			} catch (error) {
				// Per-channel failure (403 no access / 429 rate-limit / 5xx): log one
				// throttled line and keep polling every other channel. A 401 here is
				// still fatal — a bad token never recovers by continuing.
				if (isFatalDiscordError(error)) throw error;
				const message = error instanceof Error ? error.message : String(error);
				if (message !== this.lastTransientLogged) {
					this.lastTransientLogged = message;
					this.logger(`discord channel ${channel.id} poll transient: ${message}`);
				}
			}
		}
		// Persist cursors for the cycle (single writer; a failed write warns and
		// keeps polling — a replay after restart is safer than a silent drop).
		try {
			this.cursorStore.save(Object.fromEntries(this.cursors));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger(`discord cursor write failed: ${message}`);
		}
	}

	private deliver(channelId: string, m: DiscordMessage): void {
		if (!this.handler) return;
		const sender = m.author?.id;
		const text = m.content;
		if (sender === undefined || text === undefined || text === "") return;
		this.handler(
			toGatewayMessage({
				channelId: String(channelId),
				sender: String(sender),
				text,
				timestamp: m.timestamp !== undefined ? Date.parse(m.timestamp) : undefined,
			}),
		);
	}
}

/** Real DiscordClient backed by fetch to api.discord.com (v10). */
export class HttpDiscordClient implements DiscordClient {
	private readonly token: string;
	private readonly baseUrl: string;
	private readonly fetchFn: typeof fetch;

	constructor(options: HttpDiscordClientOptions) {
		this.token = options.token;
		this.baseUrl = (options.baseUrl ?? "https://discord.com/api/v10").replace(/\/+$/, "");
		this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
	}

	async sendMessage(input: { channelId: string; content: string }): Promise<void> {
		await this.request("POST", `/channels/${input.channelId}/messages`, {
			body: JSON.stringify({ content: input.content }),
		});
	}

	/** Message-capable channels the bot can see: DMs + every guild's text/news channels. */
	async listChannels(): Promise<DiscordChannel[]> {
		const dms = await this.request("GET", "/users/@me/channels");
		const guilds = await this.request("GET", "/users/@me/guilds");
		const out: DiscordChannel[] = [];
		for (const dm of Array.isArray(dms) ? dms : []) {
			if (DISCORD_TEXT_CHANNEL_TYPES.has(dm.type)) out.push({ id: String(dm.id), type: dm.type });
		}
		for (const guild of Array.isArray(guilds) ? guilds : []) {
			if (typeof guild?.id !== "string") continue;
			const channels = await this.request("GET", `/guilds/${guild.id}/channels`);
			for (const c of Array.isArray(channels) ? channels : []) {
				if (DISCORD_TEXT_CHANNEL_TYPES.has(c.type)) out.push({ id: String(c.id), type: c.type });
			}
		}
		return out;
	}

	async getMessages(input: { channelId: string; after?: string; signal?: AbortSignal }): Promise<DiscordMessage[]> {
		const query = input.after !== undefined ? `?after=${encodeURIComponent(input.after)}` : "";
		const data = await this.request("GET", `/channels/${input.channelId}/messages${query}`, { signal: input.signal });
		return Array.isArray(data) ? (data as DiscordMessage[]) : [];
	}

	private async request(
		method: string,
		path: string,
		init: { body?: string; signal?: AbortSignal } = {},
	): Promise<unknown> {
		const res = await this.fetchFn(`${this.baseUrl}${path}`, {
			method,
			headers: {
				authorization: `Bot ${this.token}`,
				...(init.body !== undefined ? { "content-type": "application/json" } : {}),
			},
			body: init.body,
			signal: init.signal,
		});
		// Discord uses real HTTP status codes: 401 (bad token) is FATAL, 403/429
		// (no access / rate-limited) and 5xx are transient. Surface them so the
		// transport classifies correctly.
		if (!res.ok) {
			throw Object.assign(new Error(`discord ${method} ${path} HTTP ${res.status}`), { status: res.status });
		}
		const text = await res.text();
		return text.length > 0 ? JSON.parse(text) : undefined;
	}
}
