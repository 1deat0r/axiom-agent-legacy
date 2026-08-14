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
import { ScheduleManager, type ScheduleReminder } from "../core/schedule/index.js";
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
import { classifyCompletionFailure, describeCompletionFailure } from "./completion-failure.js";
import { isAllowedSender, loadGatewayConfig } from "./config.js";
import type { DeliveryLedger } from "./delivery-ledger.js";
import type { RestartNoticeStore } from "./restart-notice.js";
import type { UpdateConfig, UpdateShell } from "./self-update.js";
import { applyUpdate, CliUpdateShell, checkUpdate } from "./self-update.js";
import { archiveSessionFile, sessionExceedsBudget, sessionFilePath } from "./session-reset.js";
import { GATEWAY_SESSION_TOKEN_BUDGET, sessionExceedsTokenBudget } from "./session-token-meter.js";
import { STREAM_EDIT_MIN_INTERVAL_MS, StreamEditor } from "./stream-editor.js";
import type { StreamJournal } from "./stream-journal.js";
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

/** Chat-action refresh cadence (Telegram drops actions older than ~5s). */
const TYPING_REFRESH_MS = 4_000;

/** Sleep for a fixed delay (retry backoff / deferred-restart polling). */
function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Input accepted by both completion surfaces (stream and batch). */
type GatewayRunInput = Parameters<CompletionRunner["runCompletion"]>[0];

/** The runner's result shape for either completion surface. */
type CompletionOutcome = { reply: string; sessionId: string; error?: string };

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
	/** Restart-notice store for the post-update "back online" announcement. */
	restartNoticeStore?: RestartNoticeStore;
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
	/** In-flight stream journal (streaming v2): records placeholder bubbles so a restart can recover them. */
	streamJournal?: StreamJournal;
	/**
	 * Model-facing schedule (ADR-0053): when configured, the gateway owns a
	 * ScheduleManager that sweeps the shared reminder store on boot and on a
	 * poll, running due reminders as ordinary turns in their session. Absent
	 * => schedule tools stay inert (no delivery path).
	 */
	schedule?: { storePath: string; pollMs?: number; now?: () => Date };
	/** The active transport's name, recorded on each ledger entry. */
	transportName?: string;
	/**
	 * Extra named fan-out transports (ADR-0023): send-only targets a
	 * deliverTo entry's `transport` name can address, so one run reaches
	 * channels across platforms.
	 */
	transports?: Record<string, GatewayTransport>;
	/** Extra attempts after a transient completion failure (default 1). */
	completionRetries?: number;
	/** Delay between completion retries in ms (default 5000). */
	completionRetryDelayMs?: number;
	/** Cap on how long a deferred restart waits for in-flight runs (default 30000). */
	restartGraceMs?: number;
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
	private readonly streamJournal: StreamJournal | undefined;
	private readonly schedule: ScheduleManager | undefined;
	private readonly transportName: string;
	private readonly transports: Record<string, GatewayTransport>;
	private readonly sessionsDir?: string;
	private readonly searchIndexPath?: string;
	private readonly projectRoot?: string;
	private readonly modelStore: ActiveModelStore | undefined;
	private readonly restartNoticeStore: RestartNoticeStore | undefined;
	private readonly updateApi: GatewayUpdateApi | undefined;
	private readonly restart: (() => void) | undefined;
	private readonly cron: (GatewayCronCommandApi & { start(): void; stop(): void }) | undefined;
	private readonly activeProjects: ActiveProjectStore;
	private readonly chains = new Map<string, ChannelChain>();
	private readonly completionRetries: number;
	private readonly completionRetryDelayMs: number;
	private readonly restartGraceMs: number;
	private activeRuns = 0;
	private restartPending = false;
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
		this.streamJournal = deps.streamJournal;
		this.schedule = deps.schedule
			? new ScheduleManager({
					storePath: deps.schedule.storePath,
					pollMs: deps.schedule.pollMs,
					now: deps.schedule.now,
					onDue: (reminder) => this.enqueueReminder(reminder),
				})
			: undefined;
		this.transportName = deps.transportName ?? "transport";
		this.transports = deps.transports ?? {};
		this.sessionsDir = deps.sessionsDir;
		this.searchIndexPath = deps.searchIndexPath;
		this.projectRoot = deps.projectRoot;
		this.modelStore = deps.modelStore;
		this.restartNoticeStore = deps.restartNoticeStore;
		this.updateApi = deps.update
			? {
					check: () => checkUpdate(deps.updateShell ?? new CliUpdateShell(), deps.update!),
					apply: () => applyUpdate(deps.updateShell ?? new CliUpdateShell(), deps.update!),
				}
			: undefined;
		this.restart = deps.restart;
		this.cron = deps.cron;
		this.activeProjects = deps.activeProjects ?? new FileActiveProjectStore(this.projectHome);
		this.completionRetries = Math.max(0, deps.completionRetries ?? 1);
		this.completionRetryDelayMs = Math.max(0, deps.completionRetryDelayMs ?? 5_000);
		this.restartGraceMs = Math.max(0, deps.restartGraceMs ?? 30_000);
	}

	/** One completion attempt on the stream (default) or batch surface. */
	private async runCompletionAttempt(
		input: GatewayRunInput,
		stream: boolean,
		onDelta: ((delta: string) => void) | undefined,
	): Promise<CompletionOutcome> {
		if (stream && this.completion.streamCompletion) {
			return this.completion.streamCompletion(input, onDelta ?? (() => {}));
		}
		return this.completion.runCompletion(input);
	}

	/**
	 * Run a completion with retries (ADR-0051). A transient child failure —
	 * SIGTERM/SIGKILL from a competing run or a restart, a gateway timeout, a
	 * busy session, a spawn error — is retried after a short delay. The retry
	 * drops compaction so the second attempt is as light as possible. The raw
	 * error is kept for the journal; the user sees a short classified message.
	 */
	private async runCompletionWithRetry(
		input: GatewayRunInput,
		stream: boolean,
		onDelta: ((delta: string) => void) | undefined,
	): Promise<{ result: CompletionOutcome; attempts: number }> {
		const maxAttempts = this.completionRetries + 1;
		let last: CompletionOutcome | undefined;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const attemptInput: GatewayRunInput = attempt === 0 ? input : { ...input, compactBefore: false };
			last = await this.runCompletionAttempt(attemptInput, stream, onDelta);
			if (last.error === undefined) {
				return { result: last, attempts: attempt + 1 };
			}
			const info = classifyCompletionFailure(last.error);
			if (!info.transient || attempt + 1 >= maxAttempts) {
				return { result: last, attempts: attempt + 1 };
			}
			console.error(
				`gateway: completion attempt ${attempt + 1} failed (${info.kind}); retrying in ${this.completionRetryDelayMs}ms: ${last.error}`,
			);
			await sleepMs(this.completionRetryDelayMs);
		}
		return { result: last ?? { reply: "", sessionId: input.sessionId }, attempts: maxAttempts };
	}

	/**
	 * Restart the process (after /update now), but never while a completion is
	 * in flight: killing the gateway also SIGTERMs its children. The restart
	 * is deferred until the runs settle, or dropped when the grace window
	 * expires (the operator re-runs /update now).
	 */
	private requestRestart(): void {
		if (this.activeRuns === 0) {
			this.restart?.();
			return;
		}
		if (this.restartPending) return;
		this.restartPending = true;
		void (async () => {
			const deadline = Date.now() + this.restartGraceMs;
			while (this.activeRuns > 0 && Date.now() < deadline) {
				await sleepMs(250);
			}
			// maybeFireDeferredRestart may have fired already (single restart).
			if (!this.restartPending) return;
			this.restartPending = false;
			if (this.activeRuns > 0) {
				console.error(
					"gateway: restart deferred past grace while a completion is still running; re-run /update now",
				);
				return;
			}
			this.restart?.();
		})();
	}

	/** Fire a deferred restart the moment the last in-flight run settles. */
	private maybeFireDeferredRestart(): void {
		if (this.restartPending && this.activeRuns === 0) {
			this.restartPending = false;
			this.restart?.();
		}
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.transport.onMessage((msg) => void this.enqueue(msg));
		this.cron?.start();
		await this.transport.connect();
		// Schedule sweeps after connect so a reminder missed while the gateway
		// was down can fire (and deliver) immediately on boot, exactly once.
		this.schedule?.start();
		await this.announceRestartCompletion();
	}

	/** Post-update "back online" notice, sent by this (fresh) process on boot. */
	private async announceRestartCompletion(): Promise<void> {
		const notice = this.restartNoticeStore?.readAndClear();
		if (!notice) return;
		await this.deliver(
			{ channelId: notice.channelId, recipient: notice.channelId },
			`✅ back online — updated to ${notice.sha.slice(0, 8)} and restarted cleanly.`,
		);
	}

	async stop(): Promise<void> {
		this.started = false;
		this.cron?.stop();
		this.schedule?.stop();
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
	 * Sweep the reminder store now (the manager also sweeps on boot and on a
	 * poll). Returns how many reminders fired. Tests drive this directly.
	 */
	sweepSchedule(now?: Date): number {
		return this.schedule?.sweep(now) ?? 0;
	}

	/**
	 * Queue a due reminder as an ordinary turn on its channel's serialization
	 * chain: it runs the completion in the session it was scheduled from and
	 * delivers the reply to the session's channel, exactly like a message the
	 * user sent — never interleaved with an interactive turn on that channel.
	 */
	enqueueReminder(reminder: ScheduleReminder): void {
		const prev = this.chains.get(reminder.channelId) ?? Promise.resolve();
		const next = prev.then(() => this.runReminderTurn(reminder)).catch(() => undefined);
		this.chains.set(reminder.channelId, next);
	}

	/**
	 * Run one due reminder: the reminder text becomes the turn's user message
	 * in the session it was scheduled from (the stored session id), anchored to
	 * the stored project root when there is one. The run is tagged with the
	 * channel so a schedule tool inside the turn can schedule again.
	 */
	private async runReminderTurn(reminder: ScheduleReminder): Promise<void> {
		const recipient = { channelId: reminder.channelId, recipient: reminder.channelId };
		const input = {
			sessionId: reminder.sessionId,
			prompt: reminder.text,
			profile: { name: this.profile },
			model: this.modelStore?.load(),
			channelId: reminder.channelId,
			...(reminder.projectRoot ? { projectRoot: reminder.projectRoot } : {}),
		};
		this.activeRuns++;
		try {
			await this.withPollingPaused(() => this.runBatchTurn(input, recipient));
		} finally {
			this.activeRuns--;
			this.maybeFireDeferredRestart();
		}
	}

	/**
	 * The batch completion path shared by interactive and reminder turns:
	 * run with retries, then deliver the reply (or the classified failure)
	 * over the active transport with the typing indicator around it.
	 */
	private async runBatchTurn(input: GatewayRunInput, recipient: GatewayRecipient): Promise<void> {
		const stopTyping = this.startTyping(recipient);
		try {
			const { result, attempts } = await this.runCompletionWithRetry(input, false, undefined);
			if (result.error) {
				console.error(`gateway: completion failed after ${attempts} attempt(s): ${result.error}`);
				await this.deliver(recipient, `could not run the agent: ${describeCompletionFailure(result.error)}`);
				return;
			}
			await this.deliver(recipient, `${result.reply.length > 0 ? result.reply : "(no reply)"}`);
		} finally {
			stopTyping();
		}
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

	/**
	 * Run an outbound burst with the receive long-poll paused (ADR-0039):
	 * Telegram queues outbound calls behind an open long-poll, so every
	 * delivery must pause first and resume after — even when the burst throws.
	 */
	private async withPollingPaused<T>(fn: () => Promise<T>): Promise<T> {
		this.transport.pausePolling?.();
		try {
			return await fn();
		} finally {
			this.transport.resumePolling?.();
		}
	}

	/** Reply/denial on the active transport, recorded in the ledger. */
	private deliver(to: GatewayRecipient, text: string): Promise<void> {
		return this.deliverVia(this.transport, this.transportName, to, text);
	}

	/**
	 * Resolve the channel's usable active project — the one guard shared by the
	 * agent-run path and /new. A stored name that fails the grammar (hand-edited
	 * store file) or a project deleted out-of-band is a stale entry: clear the
	 * mapping and drop its composite index entry so the /projects menu never
	 * lies, the channel runs unanchored, and /new never archives a dead session
	 * key. Returns the resolved project (name, root, generation) or undefined
	 * when the channel runs unanchored.
	 */
	private resolveUsableProject(channelId: string): { project: string; root: string; generation: number } | undefined {
		const active = this.activeProjects.get(channelId);
		if (!active) return undefined;
		const scoped = resolveProjectRoot(this.projectHome, active);
		const usable = isValidProjectName(active) && existsSync(scoped);
		if (!usable) {
			this.index.remove(`${channelId}:${active}:${this.activeProjects.generation(active)}`);
			this.activeProjects.clear(channelId);
			return undefined;
		}
		return { project: active, root: scoped, generation: this.activeProjects.generation(active) };
	}

	/**
	 * /new: archive the channel's current session file so the next agent run
	 * starts fresh. The archive keeps its *.jsonl name, so /search still
	 * indexes it. Returns a short human-readable report for the command reply.
	 */
	private resetChannelSession(channelId: string): string {
		if (!this.sessionsDir) return "sessions directory is not configured";
		// Resolve the same usable project the run path would: a stale mapping
		// (deleted project, hand-edited name) is cleared here, so /new archives
		// the session the next run will actually resume — never a dead key.
		const resolved = this.resolveUsableProject(channelId);
		const sessionKey = resolved ? `${channelId}:${resolved.project}:${resolved.generation}` : channelId;
		const path = sessionFilePath(this.sessionsDir, sessionKey);
		if (!existsSync(path)) return "no session to reset — this channel is already fresh";
		try {
			archiveSessionFile(path);
			return "started a fresh session (the old one is archived and still searchable via /search)";
		} catch {
			return "could not archive the current session";
		}
	}

	/**
	 * Fan one message out to every configured deliverTo channel (ADR-0022/
	 * 0023/0062). A target that names a transport goes to that transport only
	 * (an unknown name degrades to the active transport, ledger-labelled with
	 * what really delivered). An UNNAMED target is a broadcast: it reaches
	 * every active transport — the primary plus every built fan-out sibling —
	 * not just the channel's own transport. Returns how many sends were made.
	 */
	async deliverToAll(text: string): Promise<{ channels: number }> {
		const config = loadGatewayConfig(this.axiomHomeDir);
		const targets = config.deliverTo ?? [];
		let channels = 0;
		await this.withPollingPaused(async () => {
			for (const target of targets) {
				if (target.transport !== undefined) {
					// Resolve the actual transport first: a named target we do not hold
					// degrades to the active transport, and the ledger labels what really
					// delivered (never a phantom transport name).
					const named = this.transports[target.transport];
					const transport = named ?? this.transport;
					const name = named !== undefined ? target.transport! : this.transportName;
					await this.deliverVia(transport, name, { channelId: target.channel, recipient: "" }, text);
					channels += 1;
					continue;
				}
				// Unnamed target (ADR-0062): every active transport — the primary and
				// every built fan-out sibling — each labelled by its own name.
				const all: Array<{ transport: GatewayTransport; name: string }> = [
					{ transport: this.transport, name: this.transportName },
				];
				for (const [name, transport] of Object.entries(this.transports)) {
					all.push({ transport, name });
				}
				for (const entry of all) {
					await this.deliverVia(entry.transport, entry.name, { channelId: target.channel, recipient: "" }, text);
				}
				channels += all.length;
			}
		});
		return { channels };
	}

	private async handle(msg: GatewayMessage): Promise<void> {
		const config = loadGatewayConfig(this.axiomHomeDir);
		const allowed = this.senders.size > 0 ? this.senders.has(msg.sender) : isAllowedSender(config, msg.sender);
		if (!allowed) {
			await this.withPollingPaused(() =>
				this.deliver({ channelId: msg.channelId, recipient: msg.sender }, UNRECOGNIZED),
			);
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
				restartNoticeStore: this.restartNoticeStore,
				...(this.updateApi ? { update: this.updateApi } : {}),
				channelId: msg.channelId,
				cron: this.cron,
				ledger: this.ledger,
				deliverToAll: (text) => this.deliverToAll(text),
				deliver: (text) => this.deliver({ channelId: msg.channelId, recipient: msg.sender }, text),
				resetSession: () => this.resetChannelSession(msg.channelId),
			};
			const reply = dispatchCommand(msg.text, ctx);
			await this.withPollingPaused(async () => {
				await this.deliver({ channelId: msg.channelId, recipient: msg.sender }, reply);
				if (ctx.afterReply) await ctx.afterReply();
			});
			if (ctx.restartRequested) this.requestRestart();
			return;
		}
		// Agent run: resolve the channel's active project (if any), derive the
		// session key (channel-only when unanchored; channel:project:generation
		// when anchored — a re-created project gets a fresh generation so it
		// never resumes a deleted project's conversation), and run the
		// completion anchored to the project root (per-call override).
		const resolved = this.resolveUsableProject(msg.channelId);
		let anchoredRoot: string | undefined;
		let sessionKey = msg.channelId;
		if (resolved) {
			anchoredRoot = resolved.root;
			sessionKey = `${msg.channelId}:${resolved.project}:${resolved.generation}`;
		}
		let sessionId = this.index.get(sessionKey);
		if (sessionId === null) {
			sessionId = sessionIdForChannel(sessionKey);
			this.index.set(sessionKey, sessionId);
		}
		// Session pressure: a channel session whose model-facing surface has
		// grown past the token budget makes every reply re-process a huge
		// context (minute-scale latency before the first word). Instead of
		// archiving (which wipes the conversation's memory), request a
		// pre-run compaction: the completion child summarizes the existing
		// context, so the reply resumes on a small session while /search
		// still indexes the full history. Token pressure (ADR-0055) is the
		// primary trigger; the byte budget (ADR-0041) stays as the safety
		// limit for sessions the meter prices low. The meter resolves a real
		// tokenizer from the active provider+model when one is set (ADR-0060);
		// without a stored model it prices under the fixed-density heuristic.
		const active = this.modelStore?.load();
		let compactBefore = false;
		if (this.sessionsDir) {
			const path = sessionFilePath(this.sessionsDir, sessionKey);
			if (
				sessionExceedsTokenBudget(path, GATEWAY_SESSION_TOKEN_BUDGET, {
					provider: active?.provider,
					model: active?.model,
				}) ||
				sessionExceedsBudget(path)
			) {
				compactBefore = true;
			}
		}
		const recipient = { channelId: msg.channelId, recipient: msg.sender };
		const input = {
			sessionId,
			prompt: msg.text,
			profile: { name: this.profile },
			model: active,
			channelId: msg.channelId,
			...(anchoredRoot ? { projectRoot: anchoredRoot } : {}),
			...(compactBefore ? { compactBefore: true } : {}),
		};
		// Replies go out while the receive loop must hold (ADR-0039): Telegram
		// queues outbound calls behind an open long-poll, so an edit would hang
		// for the whole poll window. Pause before any delivery, resume after
		// (withPollingPaused resumes even when a run throws). Runs are tracked
		// so a deferred /update restart never kills a completion in flight.
		this.activeRuns++;
		try {
			await this.withPollingPaused(async () => {
				// Streaming (ADR-0004/#6, streaming v2): when both the transport and the
				// runner support it, place a placeholder bubble and edit it in place as
				// text arrives. Edits go through a StreamEditor — coalesced, strictly
				// serialized, spacing-throttled — so the Bot API is never flooded and an
				// older edit can never clobber newer text. The bubble is journaled while
				// in flight so a restart can replace a stranded "…" on boot. Any
				// placeholder-send failure falls back to the batch guarantee below.
				const streamer = this.transport;
				if (streamer.sendMessage && streamer.editMessage && this.completion.streamCompletion) {
					const sendMessage = streamer.sendMessage.bind(streamer);
					const editMessage = streamer.editMessage.bind(streamer);
					try {
						const stopTyping = this.startTyping(recipient);
						let messageId: number | undefined;
						const openedMessageIds: number[] = [];
						try {
							messageId = await sendMessage(recipient, "…");
							openedMessageIds.push(messageId);
							const editor = new StreamEditor({
								edit: (text) => editMessage(msg.channelId, messageId!, text),
								minIntervalMs: STREAM_EDIT_MIN_INTERVAL_MS,
								// Long replies roll over: when the bubble hits the
								// transport's text cap, Telegram rejects every further
								// edit — so the editor seals the bubble at the cap and a
								// fresh message continues with the overflow.
								maxTextLength: streamer.textLimit,
								rollover: async (overflow) => {
									const nextId = await sendMessage(recipient, overflow);
									openedMessageIds.push(nextId);
									this.streamJournal?.add({
										channelId: msg.channelId,
										messageId: nextId,
										startedAt: Date.now(),
									});
									messageId = nextId;
								},
							});
							this.streamJournal?.add({ channelId: msg.channelId, messageId, startedAt: Date.now() });
							// Long replies stream across several bubbles (ADR-0047):
							// the editor seals a full bubble at the transport's text
							// cap and rolls the overflow into a fresh message via the
							// rollover hook (which re-points messageId), so every
							// later edit targets the newest bubble.
							// The bubble starts empty; compaction (if requested) already
							// summarized the session before the run began.
							// Retry-aware streaming (ADR-0051): a transient child failure
							// retries inside the same bubble, and the retry drops
							// compaction so the second attempt stays light.
							let lastText = "";
							const { result: streamed, attempts } = await this.runCompletionWithRetry(input, true, (delta) => {
								if (lastText === "") stopTyping(); // text is flowing; stop pinging
								lastText += delta;
								editor.setTarget(lastText);
							});
							if (streamed.error !== undefined) {
								console.error(`gateway: completion failed after ${attempts} attempt(s): ${streamed.error}`);
							}
							const baseFinal =
								streamed.error !== undefined
									? `could not run the agent: ${describeCompletionFailure(streamed.error)}`
									: streamed.reply.length > 0
										? streamed.reply
										: "(no reply)";
							const finalText = baseFinal;
							// The editor applies the final text itself (and skips the edit
							// when the bubble already shows it, so Telegram never rejects a
							// no-op "message is not modified"). finish() rolls any pending
							// overflow into a fresh bubble first, then lands the tail.
							editor.setTarget(finalText);
							const landed = await editor.finish();
							// Fallback when the tail could not land in place: the final
							// edit failed, or the text was fully absorbed by earlier
							// bubbles (a short error after a long partial stream ends
							// up beyond the last bubble window). Deliver the unlanded
							// tail (chunked) — or the whole text when the window
							// already absorbed it — so the answer always reaches the
							// user.
							if (!landed || editor.remainingText().length === 0) {
								await this.deliver(
									recipient,
									editor.remainingText().length > 0 ? editor.remainingText() : finalText,
								);
							} else {
								// The streamed bubble(s) ARE the delivery: record it like
								// any outbound delivery so /ledger stays complete
								// (ADR-0022) and the reply carries a timestamp for latency
								// forensics.
								this.ledger?.record({
									ts: Date.now(),
									transport: this.transportName,
									channel: msg.channelId,
									recipient: msg.sender,
									chars: finalText.length,
									ok: true,
								});
							}
						} finally {
							stopTyping();
							for (const id of openedMessageIds) this.streamJournal?.remove(msg.channelId, id);
						}
						return;
					} catch {
						/* fall through to batch — the placeholder send itself failed */
					}
				}
				await this.runBatchTurn(input, recipient);
			});
		} finally {
			this.activeRuns--;
			this.maybeFireDeferredRestart();
		}
	}

	/**
	 * Ping a chat action ("typing") while a run is thinking, refreshed every
	 * TYPING_REFRESH_MS until stopped (first delta / run end). No-op when the
	 * transport has no sendChatAction capability.
	 */
	private startTyping(to: GatewayRecipient): () => void {
		const sendChatAction = this.transport.sendChatAction?.bind(this.transport);
		if (!sendChatAction) return () => {};
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const ping = () => {
			if (stopped) return;
			void sendChatAction(to, "typing").catch(() => undefined);
			timer = setTimeout(ping, TYPING_REFRESH_MS);
		};
		timer = setTimeout(ping, 0);
		return () => {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
		};
	}
}
