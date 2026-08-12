/**
 * The gateway router (ADR-0001/0006): binds a transport to a channel->session
 * mapping and routes inbound messages to agent completions or gateway-local
 * commands. Non-listed senders are denied before anything else; per-channel
 * runs are serialized so two messages never interleave one session.
 */
import { join } from "node:path";
import type { ChannelIndex } from "./channel-index.js";
import { dispatchCommand } from "./commands/index.js";
import { sessionIdForChannel } from "./completion.js";
import { isAllowedSender, loadGatewayConfig } from "./config.js";
import type {
	CompletionRunner,
	GatewayCommandContext,
	GatewayCronCommandApi,
	GatewayMessage,
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
	/** Optional gateway cron manager: lifecycle rides the gateway; /cron drives it. */
	cron?: GatewayCronCommandApi & { start(): void; stop(): void };
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
	private readonly cron: (GatewayCronCommandApi & { start(): void; stop(): void }) | undefined;
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
		this.cron = deps.cron;
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.transport.onMessage((msg) => void this.enqueue(msg));
		this.cron?.start();
		await this.transport.connect();
	}

	async stop(): Promise<void> {
		this.started = false;
		this.cron?.stop();
		await this.transport.disconnect();
	}

	/** Route one inbound message (serialized per channel). */
	enqueue(msg: GatewayMessage): Promise<void> {
		const prev = this.chains.get(msg.channelId) ?? Promise.resolve();
		const next = prev.then(() => this.handle(msg)).catch(() => undefined);
		this.chains.set(msg.channelId, next);
		return next.then(() => undefined);
	}

	private async handle(msg: GatewayMessage): Promise<void> {
		const config = loadGatewayConfig(this.axiomHomeDir);
		const allowed = this.senders.size > 0 ? this.senders.has(msg.sender) : isAllowedSender(config, msg.sender);
		if (!allowed) {
			await this.transport.send({ channelId: msg.channelId, recipient: msg.sender }, UNRECOGNIZED);
			return;
		}
		if (msg.isCommand) {
			const ctx: GatewayCommandContext = {
				profile: this.profile,
				axiomHomeDir: this.axiomHomeDir,
				projectHome: this.projectHome,
				channelId: msg.channelId,
				cron: this.cron,
			};
			const reply = dispatchCommand(msg.text, ctx);
			await this.transport.send({ channelId: msg.channelId, recipient: msg.sender }, reply);
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
			await this.transport.send(
				{ channelId: msg.channelId, recipient: msg.sender },
				`could not run the agent: ${result.error}`,
			);
			return;
		}
		await this.transport.send(
			{ channelId: msg.channelId, recipient: msg.sender },
			result.reply.length > 0 ? result.reply : "(no reply)",
		);
	}
}
