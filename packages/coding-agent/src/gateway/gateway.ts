/**
 * The gateway router (ADR-0001/0006/0022): binds a transport to a channel->
 * session mapping and routes inbound messages to agent completions or
 * gateway-local commands. Non-listed senders are denied before anything else;
 * per-channel runs are serialized so two messages never interleave one session.
 *
 * Every outbound delivery (reply, denial, command reply, fan-out) runs through
 * `deliver`, which records it in the optional delivery ledger (ADR-0022) so one
 * run can fan a result out to every configured channel and the whole history is
 * auditable via `/ledger` and `/announce`.
 */
import { join } from "node:path";
import type { ChannelIndex } from "./channel-index.js";
import { dispatchCommand } from "./commands/index.js";
import { sessionIdForChannel } from "./completion.js";
import { isAllowedSender, loadGatewayConfig } from "./config.js";
import type { DeliveryLedger } from "./delivery-ledger.js";
import type {
	CompletionRunner,
	GatewayCommandContext,
	GatewayMessage,
	GatewayRecipient,
	GatewayTransport,
} from "./types.js";

const UNRECOGNIZED = "unrecognized sender — this gateway is private to allowed senders.";

export interface GatewayDeps {
	transport: GatewayTransport;
	index: ChannelIndex;
	completion: CompletionRunner;
	axiomHomeDir: string;
	profile: string;
	senders?: string[];
	/** Resolve the active profile home (defaults to the axiom home). */
	projectHome?: string;
	/** Delivery ledger (ADR-0022); deliveries are recorded when present. */
	ledger?: DeliveryLedger;
	/** The active transport's name, recorded on each ledger entry. */
	transportName?: string;
}

/** Per-channel run chain so two messages on one session never interleave. */
type ChannelChain = Promise<unknown>;

export class Gateway {
	private readonly transport: GatewayTransport;
	private readonly index: ChannelIndex;
	private readonly completion: CompletionRunner;
	private readonly axiomHomeDir: string;
	private readonly profile: string;
	private readonly senders: Set<string>;
	private readonly projectHome: string;
	private readonly ledger: DeliveryLedger | undefined;
	private readonly transportName: string;
	private readonly chains = new Map<string, ChannelChain>();
	private started = false;

	constructor(deps: GatewayDeps) {
		this.transport = deps.transport;
		this.index = deps.index;
		this.completion = deps.completion;
		this.axiomHomeDir = deps.axiomHomeDir;
		this.profile = deps.profile;
		this.senders = new Set(deps.senders ?? []);
		this.projectHome =
			deps.projectHome ??
			(deps.profile === "default" ? deps.axiomHomeDir : join(deps.axiomHomeDir, "profiles", deps.profile));
		this.ledger = deps.ledger;
		this.transportName = deps.transportName ?? "transport";
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.transport.onMessage((msg) => void this.enqueue(msg));
		await this.transport.connect();
	}

	async stop(): Promise<void> {
		this.started = false;
		await this.transport.disconnect();
	}

	/** Route one inbound message (serialized per channel). */
	enqueue(msg: GatewayMessage): Promise<void> {
		const prev = this.chains.get(msg.channelId) ?? Promise.resolve();
		const next = prev.then(() => this.handle(msg)).catch(() => undefined);
		this.chains.set(msg.channelId, next);
		return next.then(() => undefined);
	}

	/**
	 * The single outbound path: send `text` to `to` and record it in the ledger.
	 * A transport that throws is still recorded (ok:false) and never left silent.
	 */
	private async deliver(to: GatewayRecipient, text: string): Promise<void> {
		let ok = true;
		let error: string | undefined;
		try {
			await this.transport.send(to, text);
		} catch (cause) {
			ok = false;
			error = cause instanceof Error ? cause.message : String(cause);
		}
		this.ledger?.record({
			ts: Date.now(),
			transport: this.transportName,
			channel: to.channelId,
			recipient: to.recipient,
			chars: text.length,
			ok,
			error,
		});
	}

	/**
	 * Fan one message out to every configured deliverTo channel on the active
	 * transport (ADR-0022) — the "one run reaches every channel" primitive the
	 * automation spine can feed. Returns how many channels were targeted.
	 */
	async deliverToAll(text: string): Promise<{ channels: number }> {
		const config = loadGatewayConfig(this.axiomHomeDir);
		const targets = config.deliverTo ?? [];
		for (const target of targets) {
			await this.deliver({ channelId: target.channel, recipient: "" }, text);
		}
		return { channels: targets.length };
	}

	private async handle(msg: GatewayMessage): Promise<void> {
		const config = loadGatewayConfig(this.axiomHomeDir);
		const allowed = this.senders.size > 0 ? this.senders.has(msg.sender) : isAllowedSender(config, msg.sender);
		if (!allowed) {
			await this.deliver({ channelId: msg.channelId, recipient: msg.sender }, UNRECOGNIZED);
			return;
		}
		if (msg.isCommand) {
			const ctx: GatewayCommandContext = {
				profile: this.profile,
				axiomHomeDir: this.axiomHomeDir,
				projectHome: this.projectHome,
				ledger: this.ledger,
				deliverToAll: (text) => this.deliverToAll(text),
			};
			const reply = dispatchCommand(msg.text, ctx);
			await this.deliver({ channelId: msg.channelId, recipient: msg.sender }, reply);
			return;
		}
		// Agent run: resolve (or create) the channel's session id, index it.
		let sessionId = this.index.get(msg.channelId);
		if (sessionId === null) {
			sessionId = sessionIdForChannel(msg.channelId);
			this.index.set(msg.channelId, sessionId);
		}
		const result = await this.completion.runCompletion({
			sessionId,
			prompt: msg.text,
			profile: { name: this.profile },
		});
		if (result.error) {
			await this.deliver(
				{ channelId: msg.channelId, recipient: msg.sender },
				`could not run the agent: ${result.error}`,
			);
			return;
		}
		await this.deliver(
			{ channelId: msg.channelId, recipient: msg.sender },
			result.reply.length > 0 ? result.reply : "(no reply)",
		);
	}
}
