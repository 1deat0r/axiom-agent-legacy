/**
 * The gateway router (ADR-0001/0006/0022): binds a transport to a channel->
 * session mapping and routes inbound messages to agent completions or
 * gateway-local commands. Non-listed senders are denied before anything else;
 * per-channel runs are serialized so two messages never interleave one session.
 *
 * Every outbound delivery (reply, denial, command reply, fan-out, cron) runs
 * through `deliver`, which records it in the optional delivery ledger
 * (ADR-0022) so one run can fan a result out to every configured channel and
 * the whole history is auditable via `/ledger` and `/announce`. An optional
 * cron manager (ADR — gateway cron) rides the gateway lifecycle and targets
 * `/cron` delivery at a channel.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ActiveModelStore } from "./active-model.js";
import {
	type ActiveProjectStore,
	FileActiveProjectStore,
	isValidProjectName,
	resolveProjectRoot,
} from "./active-project.js";

import type { ChannelIndex } from "./channel-index.js";
import { dispatchCommand } from "./commands/index.js";
import { sessionIdForChannel } from "./completion.js";
import { isAllowedSender, loadGatewayConfig } from "./config.js";
import type { DeliveryLedger } from "./delivery-ledger.js";
import type { UpdateConfig, UpdateShell } from "./self-update.js";
import { applyUpdate, CliUpdateShell, checkUpdate } from "./self-update.js";
import type {
	CompletionRunner,
	GatewayCommandContext,
	GatewayCronCommandApi,
	GatewayMessage,
	GatewayRecipient,
	GatewayTransport,
	GatewayUpdateApi,
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
	/** Sessions archive directory for /search cross-session recall. */
	sessionsDir?: string;
	/** Persistent sqlite FTS index file for cross-session recall. */
	searchIndexPath?: string;
	/** Per-profile active-model store (/model hotswap). */
	modelStore?: ActiveModelStore;
	/** Self-update configuration (/update, ADR-0034); inert unless set. */
	update?: UpdateConfig;
	/** Shell for update steps (tests inject a scripted fake). */
	updateShell?: UpdateShell;
	/** Restart the gateway process after a successful update (systemd restarts it). */
	restart?: () => void;
	/** Anchored project root; scopes /search unless --all is given. */
	projectRoot?: string /** Optional gateway cron manager: lifecycle rides the gateway; /cron drives it. */;
	/** Per-channel active-project store (injectable; defaults to a file store under the profile home). */
	activeProjects?: ActiveProjectStore;
	cron?: GatewayCronCommandApi & { start(): void; stop(): void };
	/** Delivery ledger (ADR-0022); deliveries are recorded when present. */
	ledger?: DeliveryLedger;
	/** The active transport's name, recorded on each ledger entry. */
	transportName?: string;
	/**
	 * Extra named fan-out transports (ADR-0023): send-only targets a
	 * deliverTo entry's `transport` name can address, so one run reaches
	 * channels across platforms.
	 */
	transports?: Record<string, GatewayTransport>;
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
	private readonly transports: Record<string, GatewayTransport>;
	private readonly sessionsDir?: string;
	private readonly searchIndexPath?: string;
	private readonly projectRoot?: string;
	private readonly modelStore: ActiveModelStore | undefined;
	private readonly updateApi: GatewayUpdateApi | undefined;
	private readonly restart: (() => void) | undefined;
	private readonly cron: (GatewayCronCommandApi & { start(): void; stop(): void }) | undefined;
	private readonly activeProjects: ActiveProjectStore;
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
		this.transports = deps.transports ?? {};
		this.sessionsDir = deps.sessionsDir;
		this.searchIndexPath = deps.searchIndexPath;
		this.projectRoot = deps.projectRoot;
		this.modelStore = deps.modelStore;
		this.updateApi = deps.update
			? {
					check: () => checkUpdate(deps.updateShell ?? new CliUpdateShell(), deps.update!),
					apply: () => applyUpdate(deps.updateShell ?? new CliUpdateShell(), deps.update!),
				}
			: undefined;
		this.restart = deps.restart;
		this.cron = deps.cron;
		this.activeProjects = deps.activeProjects ?? new FileActiveProjectStore(this.projectHome);
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

	/**
	 * The single outbound path: send `text` to `to` over one transport and
	 * record it in the ledger labelled with that transport's name. A transport
	 * that throws is still recorded (ok:false) and never left silent.
	 */
	private async deliverVia(
		transport: GatewayTransport,
		name: string,
		to: GatewayRecipient,
		text: string,
	): Promise<void> {
		let ok = true;
		let error: string | undefined;
		try {
			await transport.send(to, text);
		} catch (cause) {
			ok = false;
			error = cause instanceof Error ? cause.message : String(cause);
		}
		this.ledger?.record({
			ts: Date.now(),
			transport: name,
			channel: to.channelId,
			recipient: to.recipient,
			chars: text.length,
			ok,
			error,
		});
	}

	/** Reply/denial on the active transport, recorded in the ledger. */
	private deliver(to: GatewayRecipient, text: string): Promise<void> {
		return this.deliverVia(this.transport, this.transportName, to, text);
	}

	/**
	 * Fan one message out to every configured deliverTo channel — across
	 * transports when a target names one (ADR-0023), else the active transport
	 * (ADR-0022). Returns how many channels were targeted.
	 */
	async deliverToAll(text: string): Promise<{ channels: number }> {
		const config = loadGatewayConfig(this.axiomHomeDir);
		const targets = config.deliverTo ?? [];
		for (const target of targets) {
			// Resolve the actual transport first: a named target we do not hold
			// degrades to the active transport, and the ledger labels what really
			// delivered (never a phantom transport name).
			const named = target.transport !== undefined ? this.transports[target.transport] : undefined;
			const transport = named ?? this.transport;
			const name = named !== undefined ? target.transport! : this.transportName;
			await this.deliverVia(transport, name, { channelId: target.channel, recipient: "" }, text);
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
				activeProject: this.activeProjects.get(msg.channelId),
				activeProjects: this.activeProjects,
				dropProjectSessions: (project) => this.index.removeWhere((key) => key.includes(`:${project}:`)),
				...(this.sessionsDir ? { sessionsDir: this.sessionsDir } : {}),
				...(this.searchIndexPath ? { searchIndexPath: this.searchIndexPath } : {}),
				...(this.projectRoot ? { projectRoot: this.projectRoot } : {}),
				modelStore: this.modelStore,
				...(this.updateApi ? { update: this.updateApi } : {}),
				channelId: msg.channelId,
				cron: this.cron,
				ledger: this.ledger,
				deliverToAll: (text) => this.deliverToAll(text),
				deliver: (text) => this.deliver({ channelId: msg.channelId, recipient: msg.sender }, text),
			};
			const reply = dispatchCommand(msg.text, ctx);
			await this.deliver({ channelId: msg.channelId, recipient: msg.sender }, reply);
			if (ctx.afterReply) await ctx.afterReply();
			if (ctx.restartRequested) this.restart?.();
			return;
		}
		// Agent run: resolve the channel's active project (if any), derive the
		// session key (channel-only when unanchored; channel:project:generation
		// when anchored — a re-created project gets a fresh generation so it
		// never resumes a deleted project's conversation), and run the
		// completion anchored to the project root (per-call override).
		const active = this.activeProjects.get(msg.channelId);
		let anchoredRoot: string | undefined;
		let sessionKey = msg.channelId;
		if (active) {
			const scoped = resolveProjectRoot(this.projectHome, active);
			// A stored name that fails the grammar (hand-edited store file) or a
			// project deleted out-of-band is a stale entry: clear it and drop its
			// composite mapping so the /projects menu never lies, the channel runs
			// unanchored, and a re-created project never resumes the dead session.
			const usable = isValidProjectName(active) && existsSync(scoped);
			if (!usable) {
				this.index.remove(`${msg.channelId}:${active}:${this.activeProjects.generation(active)}`);
				this.activeProjects.clear(msg.channelId);
			} else {
				anchoredRoot = scoped;
				sessionKey = `${msg.channelId}:${active}:${this.activeProjects.generation(active)}`;
			}
		}
		let sessionId = this.index.get(sessionKey);
		if (sessionId === null) {
			sessionId = sessionIdForChannel(sessionKey);
			this.index.set(sessionKey, sessionId);
		}
		const result = await this.completion.runCompletion({
			sessionId,
			prompt: msg.text,
			profile: { name: this.profile },
			model: this.modelStore?.load(),
			...(anchoredRoot ? { projectRoot: anchoredRoot } : {}),

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
