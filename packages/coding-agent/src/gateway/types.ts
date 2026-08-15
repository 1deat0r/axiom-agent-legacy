/**
 * Gateway types (the axiom messaging gateway, ADR-0001/0004/0006, first port
 * onto the prime-agent v0.7.2 baseline). One sender channels to one session.
 */
import type { AgentCronJob } from "../core/cron-jobs.js";
import type { ActiveModelStore } from "./active-model.js";
import type { ActiveProjectStore } from "./active-project.js";
import type { DeliveryLedger } from "./delivery-ledger.js";
import type { RestartNoticeStore } from "./restart-notice.js";
import type { UpdateApply, UpdateCheck } from "./self-update.js";

/** A normalized, platform-agnostic inbound or outbound message. */

export interface GatewayMessage {
	channelId: string;
	sender: string;
	text: string;
	isCommand: boolean;
	timestamp: number;
}

/** A typed outbound delivery address. */
export interface GatewayRecipient {
	channelId: string;
	recipient: string;
}

/** ADR-0001 transport contract. */
export interface GatewayTransport {
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	send(to: GatewayRecipient, text: string): Promise<void>;
	onMessage(handler: (msg: GatewayMessage) => void): void;
	/**
	 * Polling transports (Telegram, ADR-0039): hold the receive loop while a
	 * reply is being delivered. Some Bot APIs queue concurrent calls behind an
	 * open long-poll, so outbound sends/edits must not race the poll — the
	 * gateway pauses before delivering and resumes after. Optional: send-only
	 * fan-out transports and Signal have no poll to hold.
	 */
	pausePolling?(): void;
	resumePolling?(): void;
	/**
	 * Optional streaming support (ADR-0004/#6): place a bubble and edit it in
	 * place as text arrives. Absent => batch-only delivery.
	 */
	sendMessage?(to: GatewayRecipient, text: string): Promise<number>;
	editMessage?(chatId: string, messageId: number, text: string): Promise<void>;
	/**
	 * Max characters a streamed bubble may hold before it must roll over into a
	 * new message (Telegram rejects edits beyond 4096). Absent => no rollover.
	 */
	textLimit?: number;
	/**
	 * Optional typing indicator (Telegram chatAction). The gateway pings it
	 * while a run is "thinking" and stops once text flows. Absent => skipped.
	 */
	sendChatAction?(to: GatewayRecipient, action: string): Promise<void>;
}

/** The profile a gateway run boots under (SOUL.md rides the prompt). */
export interface GatewayProfile {
	name: string;
}

/** Runs one agent completion and returns the reply + the channel's session id. */
export interface CompletionRunner {
	runCompletion(input: {
		sessionId: string;
		prompt: string;
		profile: GatewayProfile;
		/** Optional active-model override (provider/model) from /model. */
		model?: { provider: string; model: string };
		/** Per-run anchor override; wins over the runner's boot-time root. */
		projectRoot?: string;
		/** Compact the session before the run (gateway session-budget path). */
		compactBefore?: boolean;
		/** The channel the run belongs to (tagged on the child so schedule tools work). */
		channelId?: string;
	}): Promise<{
		reply: string;
		sessionId: string;
		error?: string;
	}>;
	/** Optional streaming variant: forwards text deltas; absent => batch-only. */
	streamCompletion?(
		input: {
			sessionId: string;
			prompt: string;
			profile: GatewayProfile;
			model?: { provider: string; model: string };
			projectRoot?: string;
			compactBefore?: boolean;
			channelId?: string;
		},
		onDelta: (delta: string) => void,
	): Promise<{ reply: string; sessionId: string; error?: string }>;
}

/** The cron surface the /cron command drives (list/add/remove). */
export interface GatewayCronCommandApi {
	listJobs(): AgentCronJob[];
	addJob(input: { channelId: string; scheduleText: string; prompt: string; label?: string }): AgentCronJob;
	removeJob(id: string): AgentCronJob | undefined;
}

/** The self-update surface the /update command drives (ADR-0034). */
export interface GatewayUpdateApi {
	check(): Promise<UpdateCheck>;
	apply(): Promise<UpdateApply>;
}

/** A gateway-local command handler (never reaches the model). */
export interface GatewayCommand {
	name: string;
	summary: string;
	handler(args: string[], ctx: GatewayCommandContext): Promise<string> | string;
}

export interface GatewayCommandContext {
	profile: string;
	axiomHomeDir: string;
	projectHome: string;
	/** Per-profile active-model store (/model hotswap); optional. */
	modelStore?: ActiveModelStore;
	/** Self-update surface (/update); absent = not configured. */
	update?: GatewayUpdateApi;
	/** Deferred action: runs after the command's reply has been delivered. */
	afterReply?: () => Promise<void> | void;
	/** Set by a command's deferred action to restart the gateway process. */
	restartRequested?: boolean;
	/** Records the post-restart "back online" notice (/update); absent = not configured. */
	restartNoticeStore?: RestartNoticeStore;
	/** Deliver a follow-up to the channel the command arrived on. */
	deliver?: (text: string) => Promise<void>;
	/** The channel's current active project (gateway-resolved; undefined when unset). */
	activeProject?: string;
	/** Per-channel active-project store, so commands can switch/clear live. */
	activeProjects?: ActiveProjectStore;
	/** Ask the gateway to drop every session mapping for a project (used by /projects rm). */
	dropProjectSessions?(project: string): void;

	/** Archive this channel's session so the next run starts fresh (/new). */
	resetSession?: () => string;

	/** Sessions archive directory for cross-session recall (/search). */
	sessionsDir?: string;
	/** Persistent sqlite FTS index file for cross-session recall. */
	searchIndexPath?: string;
	/** Anchored project root; /search scopes to it unless --all is given. */
	projectRoot?: string /** The channel the inbound command arrived on (cron delivery target). */;
	channelId?: string;
	/** The gateway's cron manager, when wired (drives /cron). */
	cron?: GatewayCronCommandApi;
	/** Delivery ledger (ADR-0022) for the /ledger audit command. */
	ledger?: DeliveryLedger;
	/** Fan one message out to every configured deliverTo channel (ADR-0022). */
	deliverToAll?(text: string): Promise<{ channels: number }>;
}

/** The resolved command reply for one inbound command message. */
export interface CommandResult {
	reply: string;
}

/** Gateway configuration under the profile home. */
export interface GatewayConfig {
	/** Allowlisted senders — only these may reach the model/commands. */
	senders: string[];
	/**
	 * Fan-out targets for /announce (ADR-0022/0023). Each may name a `transport`
	 * (default: the active transport) so one run can reach channels across
	 * platforms.
	 */
	deliverTo?: Array<{ transport?: string; channel: string }>;
}
