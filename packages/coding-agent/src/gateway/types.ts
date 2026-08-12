/**
 * Gateway types (the axiom messaging gateway, ADR-0001/0004/0006, first port
 * onto the axiom v0.7.2 baseline). One sender channels to one session.
 */
import type { AgentCronJob } from "../core/cron-jobs.js";
/** A normalized, platform-agnostic inbound or outbound message. */
import type { ActiveModelStore } from "./active-model.js";
import type { DeliveryLedger } from "./delivery-ledger.js";

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
	}): Promise<{
		reply: string;
		sessionId: string;
		error?: string;
	}>;
}

/** The cron surface the /cron command drives (list/add/remove). */
export interface GatewayCronCommandApi {
	listJobs(): AgentCronJob[];
	addJob(input: { channelId: string; scheduleText: string; prompt: string; label?: string }): AgentCronJob;
	removeJob(id: string): AgentCronJob | undefined;
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
	/** Sessions archive directory for cross-session recall (/search). */
	/** Per-profile active-model store (/model hotswap); optional. */
	modelStore?: ActiveModelStore;
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
