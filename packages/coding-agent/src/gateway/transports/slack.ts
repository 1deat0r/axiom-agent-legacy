/**
 * Slack transport (ADR-0021): adapts the Slack Web API to the gateway's typed
 * transport contract, reusing the Telegram/Discord shape (ADR-0017/0020). A bot
 * talks to api.slack.com over HTTPS with a Bot token (`xoxb-...`). Receiving is
 * REST long-poll: each poll lists the conversations the bot is in
 * (`conversations.list`) and pulls `conversations.history` per channel past the
 * last delivered message `ts` (mirrors Discord's getMessages-after-cursor and
 * Telegram's getUpdates offset). Tests inject a fake SlackClient;
 * HttpSlackClient is exercised against a local server, never a live bot.
 *
 * Slack returns HTTP 200 with an `ok:false` body on error (not HTTP status
 * codes), so fatal classification reads the body's `error` field the way
 * Telegram reads its `error_code` — invalid_auth etc. are fatal, everything
 * else transient.
 *
 * Security posture mirrors the other transports: channelId = the Slack channel
 * id; sender = the message author's Slack user id — gated by the shared
 * config.json sender allowlist in the router before any model call.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { stripColorDescriptors } from "@earendil-works/pi-tui";
import { toGatewayMessage } from "../messages.js";
import type { GatewayMessage, GatewayRecipient, GatewayTransport } from "../types.js";
import { chunkTelegramText } from "./telegram.js";

/** The Slack chat.postMessage `text` field cap (chars). */
export const SLACK_TEXT_LIMIT = 40_000;

/** Conversations.list `types` we poll for messages (DMs, public, private channels). */
export const SLACK_CONVERSATION_TYPES = "im,public_channel,private_channel,mpim";

/** Slack `error` codes that are fatal (bad/revoked bot token) — never recover by continuing. */
export const FATAL_SLACK_ERRORS = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked"]);

/** One message from conversations.history (the fields the transport consumes). */
export interface SlackMessage {
	/** Slack user id of the author (absent for some bot/system messages). */
	user?: string;
	text?: string;
	/** Slack message timestamp (the receive cursor). */
	ts?: string;
	channel?: string;
}

/** A conversation the bot can see. */
export interface SlackChannel {
	id: string;
}

/** The Slack Web API boundary (a real client talks HTTPS; tests fake this). */
export interface SlackClient {
	postMessage(input: { channel: string; text: string }): Promise<void>;
	/** All message-capable conversations the bot can see (DMs + channels). */
	listChannels(): Promise<SlackChannel[]>;
	/** Messages on one channel with ts strictly greater than `oldest`. */
	history(input: { channel: string; oldest?: string; signal?: AbortSignal }): Promise<SlackMessage[]>;
}

/** Construct options for the real HTTP client. */
export interface HttpSlackClientOptions {
	token: string;
	/** Defaults to https://slack.com/api. */
	baseUrl?: string;
	/** Injectable fetch for the local-server test; defaults to global fetch. */
	fetchFn?: typeof fetch;
}

/**
 * Slack's `text` cap is far looser than Telegram/Discord, but the split rule is
 * identical (last whitespace at or before the limit, hard-split fallback), so
 * we reuse the channel-agnostic chunker and name it Slack-shaped for readers.
 */
export function chunkSlackText(text: string, limit = SLACK_TEXT_LIMIT): string[] {
	return chunkTelegramText(text, limit);
}

/** Persists the per-channel receive cursor (last message ts) so restarts do not replay. */
export interface SlackCursorStore {
	load(): Record<string, string>;
	save(cursors: Record<string, string>): void;
}

/** In-memory cursor store (no persistence) — the safe default for tests. */
export class MapSlackCursorStore implements SlackCursorStore {
	private map = new Map<string, string>();
	load(): Record<string, string> {
		return Object.fromEntries(this.map);
	}
	save(cursors: Record<string, string>): void {
		this.map = new Map(Object.entries(cursors));
	}
}

/** Json cursor store under the gateway dir (single writer, best-effort). */
export class FileSlackCursorStore implements SlackCursorStore {
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

export interface SlackTransportOptions {
	/** Pause between poll cycles (REST polling has no long-poll). */
	pollIntervalMs?: number;
	/** Backoff after a transient poll failure. */
	backoffMs?: number;
	/** Cursor store; defaults to in-memory. */
	cursorStore?: SlackCursorStore;
	/** Stderr/observability sink; defaults to console.error. */
	logger?: (line: string) => void;
}

/** A fatal, non-transient Slack rejection (bad token via ok:false `error`, or HTTP 401). */
export function isFatalSlackError(error: unknown): boolean {
	const status = (error as { status?: number }).status;
	if (status === 401) return true;
	const slackError = (error as { slackError?: string }).slackError;
	return slackError !== undefined && FATAL_SLACK_ERRORS.has(slackError);
}

/**
 * Polling GatewayTransport over the Slack Web API, reusing the Discord
 * transport's per-channel cursor model: each poll lists conversations, pulls
 * each one's history past the last delivered ts, delivers new messages, and
 * advances the cursor. conversations.history's `oldest` is inclusive, so the
 * transport delivers only messages with ts strictly greater than the stored
 * cursor (exclusive semantics, no replay). A channel whose history fails is
 * logged (throttled) and skipped so every other channel still delivers; only a
 * fatal token error stops the loop.
 */
export class SlackTransport implements GatewayTransport {
	private readonly client: SlackClient;
	private readonly intervalMs: number;
	private readonly backoffMs: number;
	private readonly cursorStore: SlackCursorStore;
	private readonly logger: (line: string) => void;
	private readonly cursors = new Map<string, string>();
	private handler: ((msg: GatewayMessage) => void) | undefined;
	private stopped = false;
	private controller: AbortController | undefined;
	private running = false;
	private lastTransientLogged: string | undefined;

	constructor(client: SlackClient, options: SlackTransportOptions = {}) {
		this.client = client;
		this.intervalMs = options.pollIntervalMs ?? 2_000;
		this.backoffMs = options.backoffMs ?? 1_000;
		this.cursorStore = options.cursorStore ?? new MapSlackCursorStore();
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
		const chunks = chunkSlackText(stripColorDescriptors(text), SLACK_TEXT_LIMIT);
		for (const chunk of chunks) {
			try {
				await this.client.postMessage({ channel: to.channelId, text: chunk });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger(`slack send failed (channel ${to.channelId}): ${message}`);
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
				if (isFatalSlackError(error)) {
					const message = error instanceof Error ? error.message : String(error);
					this.logger(`slack polling stopped (fatal): ${message}`);
					this.stopped = true;
					this.running = false;
					break;
				}
				const message = error instanceof Error ? error.message : String(error);
				if (message !== this.lastTransientLogged) {
					this.lastTransientLogged = message;
					this.logger(`slack polling transient: ${message}`);
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
				const messages = await this.client.history({ channel: channel.id, oldest: after, signal });
				let max = after;
				for (const m of messages) {
					// `oldest` is inclusive — only deliver ts strictly newer than the cursor
					// so a restart never replays the boundary message.
					if (m.ts === undefined || (after !== undefined && m.ts <= after)) continue;
					if (max === undefined || m.ts > max) max = m.ts;
					this.deliver(channel.id, m);
				}
				if (max !== undefined && max !== after) this.cursors.set(channel.id, max);
			} catch (error) {
				if (isFatalSlackError(error)) throw error;
				const message = error instanceof Error ? error.message : String(error);
				if (message !== this.lastTransientLogged) {
					this.lastTransientLogged = message;
					this.logger(`slack channel ${channel.id} poll transient: ${message}`);
				}
			}
		}
		try {
			this.cursorStore.save(Object.fromEntries(this.cursors));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger(`slack cursor write failed: ${message}`);
		}
	}

	private deliver(channelId: string, m: SlackMessage): void {
		if (!this.handler) return;
		const sender = m.user;
		const text = m.text;
		if (sender === undefined || text === undefined || text === "") return;
		this.handler(
			toGatewayMessage({
				channelId: String(channelId),
				sender: String(sender),
				text,
				timestamp: m.ts !== undefined ? slackTsToMs(m.ts) : undefined,
			}),
		);
	}
}

/** Convert a Slack message ts ("1234567890.123456") to an epoch-ms timestamp. */
export function slackTsToMs(ts: string): number {
	const seconds = Number.parseFloat(ts);
	return Number.isFinite(seconds) ? Math.round(seconds * 1000) : Date.now();
}

/** Real SlackClient backed by fetch to api.slack.com (Web API). */
export class HttpSlackClient implements SlackClient {
	private readonly token: string;
	private readonly baseUrl: string;
	private readonly fetchFn: typeof fetch;

	constructor(options: HttpSlackClientOptions) {
		this.token = options.token;
		this.baseUrl = (options.baseUrl ?? "https://slack.com/api").replace(/\/+$/, "");
		this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
	}

	async postMessage(input: { channel: string; text: string }): Promise<void> {
		await this.request("chat.postMessage", { channel: input.channel, text: input.text });
	}

	/**
	 * Socket Mode link (ADR-0062): `apps.connections.open` with the app-level
	 * (xapp-) token returns the wss url to connect. The caller validates the
	 * url host before opening a socket; this only surfaces the response.
	 */
	async appsConnectionsOpen(): Promise<{ url: string }> {
		const data = await this.request("apps.connections.open", {});
		const url = (data as { url?: unknown }).url;
		if (typeof url !== "string" || url.length === 0) {
			throw Object.assign(new Error("slack apps.connections.open rejected: missing url"), {
				status: 400,
				slackError: "missing_url",
			});
		}
		return { url };
	}

	/** Message-capable conversations the bot can see: DMs + public/private channels. */
	async listChannels(): Promise<SlackChannel[]> {
		const data = await this.request("conversations.list", { types: SLACK_CONVERSATION_TYPES, limit: 200 });
		const channels = (data as { channels?: Array<{ id?: string }> }).channels ?? [];
		return channels.filter((c): c is { id: string } => typeof c.id === "string").map((c) => ({ id: c.id }));
	}

	async history(input: { channel: string; oldest?: string; signal?: AbortSignal }): Promise<SlackMessage[]> {
		const body: Record<string, unknown> = { channel: input.channel, limit: 100 };
		if (input.oldest !== undefined) body.oldest = input.oldest;
		const data = await this.request("conversations.history", body, input.signal);
		const messages = (data as { messages?: SlackMessage[] }).messages;
		return Array.isArray(messages) ? messages : [];
	}

	private async request(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const res = await this.fetchFn(`${this.baseUrl}/${method}`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		if (res.status === 429) {
			// Slack rate-limit: transient (retry after backoff), not fatal.
			throw Object.assign(new Error(`slack ${method} rate limited`), { status: 429 });
		}
		if (!res.ok) {
			// Non-429 HTTP error (5xx): transient; a hypothetical 401 is fatal.
			throw Object.assign(new Error(`slack ${method} HTTP ${res.status}`), { status: res.status });
		}
		const data = (await res.json()) as { ok?: boolean; error?: string };
		// Slack reports API errors as HTTP 200 with `ok:false` — read the body's
		// `error` field so fatal classification (invalid_auth etc.) is trustworthy.
		if (data.ok !== true) {
			const error = data.error ?? "unknown";
			throw Object.assign(new Error(`slack ${method} rejected: ${error}`), { status: 400, slackError: error });
		}
		return data;
	}
}
