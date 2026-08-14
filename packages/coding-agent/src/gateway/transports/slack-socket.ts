/**
 * Slack Socket Mode transport (ADR-0062): receive over the Socket Mode
 * websocket (apps.connections.open -> wss link -> events_api frames -> ack
 * per envelope), send over the Web API REST client (chat.postMessage) — the
 * same split every Slack app uses. Selected for the slack transport only when
 * `SLACK_SOCKET_MODE=1` (with `AXIOM_SLACK_APP_TOKEN`); REST-poll receive
 * stays the default.
 *
 * Security posture (S-class: transport receive is an untrusted-input surface).
 * Every frame is hostile until proven otherwise:
 * - a frame must be a JSON string within the size cap, else it is dropped
 *   unread (never parsed, never delivered, never acked);
 * - an `events_api` frame must carry a non-empty string `envelope_id`, else
 *   it is dropped without an ack;
 * - only an `event_callback` whose `event.type === "message"` with non-empty
 *   string `user`/`text`/`channel` is delivered — the channel is taken from
 *   the event itself, so no side-channel field can reroute a delivery;
 * - each envelope id is delivered at most once (a replay cache), while the
 *   ack stays idempotent so Slack never retransmits a delivered frame;
 * - the socket url is confined to `wss:` on slack.com (a forged
 *   apps.connections.open response cannot redirect the socket);
 * - tokens and `ticket=` query values are redacted from every log line.
 * The sender allowlist in the router remains the deny-before-model gate,
 * exactly as on the REST-poll path.
 */

import { toGatewayMessage } from "../messages.js";
import type { GatewayMessage, GatewayRecipient, GatewayTransport } from "../types.js";
import { chunkSlackText, SLACK_TEXT_LIMIT, slackTsToMs } from "./slack.js";

/** Default max frame size (chars) before a socket frame is dropped unread. */
export const SLACK_SOCKET_MAX_FRAME_CHARS = 262_144;

/** Default replay-cache cap (delivered envelope ids remembered). */
export const SLACK_SOCKET_MAX_SEEN_ENVELOPES = 10_000;

/** Default delay before reconnecting after a socket closes or an open fails. */
export const SLACK_SOCKET_RECONNECT_MS = 3_000;

/** Default wait for the socket to open before the attempt is abandoned. */
export const SLACK_SOCKET_OPEN_TIMEOUT_MS = 10_000;

/** The minimal WebSocket boundary the transport drives (real: the node global WebSocket). */
export interface SlackSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code?: number; reason?: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
}

export type SlackSocketFactory = (url: string) => SlackSocket;

/** The Slack API surface the socket transport needs (open the link + send). */
export interface SlackSocketApi {
	/** apps.connections.open with the app-level (xapp-) token. */
	appsConnectionsOpen(): Promise<{ url: string }>;
	/** chat.postMessage with the bot (xoxb-) token. */
	postMessage(input: { channel: string; text: string }): Promise<void>;
}

export interface SlackSocketTransportOptions {
	/** Reconnect delay after a socket closes or an open fails (default 3000). */
	reconnectDelayMs?: number;
	/** Frames larger than this (chars) are dropped unread (default 256K). */
	maxFrameChars?: number;
	/** Replay-cache cap: delivered envelope ids remembered (default 10k). */
	maxSeenEnvelopes?: number;
	/** Wait for the socket to open before abandoning the attempt (default 10s). */
	openTimeoutMs?: number;
	/** Logger; secrets are redacted before any line reaches it. */
	logger?: (line: string) => void;
	/** Injectable socket factory; defaults to the node global WebSocket. */
	socketFactory?: SlackSocketFactory;
	/** Secrets to strip from every log line (app + bot tokens). */
	secrets?: string[];
}

/** The default factory: a WHATWG WebSocket bridged onto the narrow interface. */
export function defaultSlackSocketFactory(url: string): SlackSocket {
	const ws = new WebSocket(url);
	const socket: SlackSocket = {
		send: (data: string) => ws.send(data),
		close: (code?: number, reason?: string) => ws.close(code, reason),
		onopen: null,
		onmessage: null,
		onclose: null,
		onerror: null,
	};
	ws.onopen = () => {
		socket.onopen?.({});
	};
	ws.onmessage = (event) => {
		socket.onmessage?.({ data: event.data });
	};
	ws.onclose = (event) => {
		socket.onclose?.({ code: event.code, reason: event.reason });
	};
	ws.onerror = () => {
		socket.onerror?.({});
	};
	return socket;
}

/** `SLACK_SOCKET_MODE` env gate: "1" or "true" (case-insensitive) enables Socket Mode. */
export function isSlackSocketModeEnabled(env: Record<string, string | undefined>): boolean {
	const raw = env.SLACK_SOCKET_MODE;
	return raw === "1" || (raw ?? "").toLowerCase() === "true";
}

/** A wss url on slack.com only — a forged open response cannot redirect the socket. */
export function isSafeSlackSocketUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "wss:") return false;
	const host = parsed.hostname;
	return host === "slack.com" || host.endsWith(".slack.com");
}

/**
 * Strip Slack secrets from a line before it reaches the logger: every listed
 * token and every `ticket=` query value (the socket-connect authority) become
 * `[redacted]`. Pure so tests pin the exact behavior.
 */
export function redactSlackSecrets(line: string, secrets: string[]): string {
	let out = line;
	for (const secret of secrets) {
		if (secret.length > 0) out = out.split(secret).join("[redacted]");
	}
	return out.replace(/ticket=[^&\s"')\]]+/g, "ticket=[redacted]");
}

/**
 * Socket Mode receive + REST send. Connect opens the link url and drives the
 * socket until it closes; every close (including Slack's `disconnect` frame)
 * reconnects after the backoff, re-opening the link url so a
 * `refresh_disconnect_url` is honored. Deliveries go through the same
 * sender-allowlist gate as the REST-poll transport (router-level), and sends
 * reuse the REST chunking at the Slack text cap.
 */
export class SlackSocketTransport implements GatewayTransport {
	private readonly api: SlackSocketApi;
	private readonly reconnectDelayMs: number;
	private readonly maxFrameChars: number;
	private readonly maxSeenEnvelopes: number;
	private readonly openTimeoutMs: number;
	private readonly logger: (line: string) => void;
	private readonly socketFactory: SlackSocketFactory;
	private readonly secrets: string[];
	private readonly seenEnvelopes = new Map<string, true>();
	private handler: ((msg: GatewayMessage) => void) | undefined;
	private stopped = false;
	private running = false;
	private socket: SlackSocket | undefined;

	constructor(api: SlackSocketApi, options: SlackSocketTransportOptions = {}) {
		this.api = api;
		this.reconnectDelayMs = options.reconnectDelayMs ?? SLACK_SOCKET_RECONNECT_MS;
		this.maxFrameChars = options.maxFrameChars ?? SLACK_SOCKET_MAX_FRAME_CHARS;
		this.maxSeenEnvelopes = options.maxSeenEnvelopes ?? SLACK_SOCKET_MAX_SEEN_ENVELOPES;
		this.openTimeoutMs = options.openTimeoutMs ?? SLACK_SOCKET_OPEN_TIMEOUT_MS;
		this.logger = options.logger ?? ((line) => console.error(line));
		this.socketFactory = options.socketFactory ?? defaultSlackSocketFactory;
		this.secrets = options.secrets ?? [];
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
		this.closeQuietly(this.socket);
		this.socket = undefined;
		return Promise.resolve();
	}

	/** Test introspection: whether the receive loop is running. */
	isRunning(): boolean {
		return this.running;
	}

	onMessage(handler: (msg: GatewayMessage) => void): void {
		this.handler = handler;
	}

	async send(to: GatewayRecipient, text: string): Promise<void> {
		const chunks = chunkSlackText(text, SLACK_TEXT_LIMIT);
		for (const chunk of chunks) {
			try {
				await this.api.postMessage({ channel: to.channelId, text: chunk });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.log(`slack socket send failed (channel ${to.channelId}): ${message}`);
				break;
			}
		}
	}

	private log(line: string): void {
		this.logger(redactSlackSecrets(String(line), this.secrets));
	}

	private backoff(): Promise<void> {
		return new Promise((r) => setTimeout(r, this.reconnectDelayMs));
	}

	private closeQuietly(socket: SlackSocket | undefined): void {
		try {
			socket?.close();
		} catch {
			/* the socket is already gone; the close event drives reconnection */
		}
	}

	/** The receive loop: open the link, drive the socket, reconnect forever. */
	private async loop(): Promise<void> {
		while (!this.stopped) {
			let socket: SlackSocket | undefined;
			try {
				const { url } = await this.api.appsConnectionsOpen();
				if (!isSafeSlackSocketUrl(url)) {
					// A forged open response (or a compromised API) cannot redirect
					// the socket. Log the refusal without the url and retry later.
					this.log("slack socket: apps.connections.open returned an unsafe url (refusing to connect)");
					await this.backoff();
					continue;
				}
				socket = this.socketFactory(url);
				this.socket = socket;
				// Install the frame handlers BEFORE waiting for open: a frame (or
				// a close) can arrive the moment the socket opens, and dropping it
				// would lose a real message. driveSocket keeps running until close.
				const closed = this.driveSocket(socket);
				await this.openSocket(socket, closed);
				await closed;
			} catch (error) {
				if (this.stopped) break;
				const message = error instanceof Error ? error.message : String(error);
				this.log(`slack socket connect failed: ${message}`);
				this.closeQuietly(socket);
			} finally {
				this.socket = undefined;
			}
			if (this.stopped) break;
			await this.backoff();
		}
		this.running = false;
	}

	/**
	 * Wait for the socket to open (or abandon the attempt on error/timeout/
	 * pre-open close). The frame handlers are already installed (driveSocket
	 * ran first), so no frame that arrives during the open handshake is lost.
	 */
	private async openSocket(socket: SlackSocket, closed: Promise<void>): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("slack socket open timed out")), this.openTimeoutMs);
			socket.onopen = () => {
				clearTimeout(timer);
				resolve();
			};
			socket.onerror = () => {
				clearTimeout(timer);
				reject(new Error("slack socket failed to open"));
			};
			void closed.then(() => {
				clearTimeout(timer);
				reject(new Error("slack socket closed before it opened"));
			});
		});
	}

	/** Drive an open socket until it closes. A bad frame never kills the loop. */
	private driveSocket(socket: SlackSocket): Promise<void> {
		return new Promise<void>((resolve) => {
			socket.onmessage = (event) => {
				try {
					this.handleFrame(event.data);
				} catch {
					/* malformed frames are dropped inside handleFrame; never throw */
				}
			};
			socket.onclose = () => resolve();
			socket.onerror = () => {
				/* the close event follows and drives reconnection */
			};
		});
	}

	/** One untrusted frame. See the module doc for the full threat posture. */
	private handleFrame(raw: unknown): void {
		if (typeof raw !== "string") return;
		if (raw.length > this.maxFrameChars) {
			this.log(`slack socket: dropped an oversized frame (${raw.length} chars)`);
			return;
		}
		let frame: unknown;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
		const record = frame as Record<string, unknown>;
		if (record.type === "events_api") {
			const envelopeId =
				typeof record.envelope_id === "string" && record.envelope_id.length > 0 ? record.envelope_id : undefined;
			// No envelope id -> nothing to ack and nothing trustworthy to deliver.
			if (envelopeId === undefined) return;
			// Replay guard: deliver each envelope at most once, ack every time
			// (idempotent) so Slack never retransmits a delivered frame.
			if (!this.seenEnvelopes.has(envelopeId)) {
				this.deliverEvent(record.payload);
				this.rememberEnvelope(envelopeId);
			}
			this.ack(envelopeId);
			return;
		}
		if (record.type === "disconnect") {
			const reason = typeof record.reason === "string" ? record.reason : "unknown";
			this.log(`slack socket: disconnect frame (reason ${reason}); reconnecting`);
			this.closeQuietly(this.socket);
			return;
		}
		// hello and unknown frame types: ignored.
	}

	/** Deliver one well-formed message event; everything else is dropped. */
	private deliverEvent(payload: unknown): void {
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
		const record = payload as Record<string, unknown>;
		if (record.type !== "event_callback") return;
		const event = record.event;
		if (typeof event !== "object" || event === null || Array.isArray(event)) return;
		const e = event as Record<string, unknown>;
		if (e.type !== "message") return;
		// channelId/sender come from the event itself — a side-channel field on
		// the payload can never reroute a delivery.
		const channel = e.channel;
		const user = e.user;
		const text = e.text;
		if (typeof channel !== "string" || channel.length === 0) return;
		if (typeof user !== "string" || user.length === 0) return;
		if (typeof text !== "string" || text.length === 0) return;
		const ts = typeof e.ts === "string" ? e.ts : undefined;
		if (!this.handler) return;
		this.handler(
			toGatewayMessage({
				channelId: channel,
				sender: user,
				text,
				timestamp: ts !== undefined ? slackTsToMs(ts) : undefined,
			}),
		);
	}

	private rememberEnvelope(id: string): void {
		if (this.seenEnvelopes.size >= this.maxSeenEnvelopes) {
			const oldest = this.seenEnvelopes.keys().next().value;
			if (oldest !== undefined) this.seenEnvelopes.delete(oldest);
		}
		this.seenEnvelopes.set(id, true);
	}

	private ack(envelopeId: string): void {
		try {
			this.socket?.send(JSON.stringify({ envelope_id: envelopeId }));
		} catch {
			/* a dead socket reconnects; Slack retransmits the envelope */
		}
	}
}
