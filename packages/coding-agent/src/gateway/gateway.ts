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
import type { RestartNoticeStore } from "./restart-notice.js";
import type { UpdateConfig, UpdateShell } from "./self-update.js";
import { applyUpdate, CliUpdateShell, checkUpdate } from "./self-update.js";
import { archiveSessionFile, sessionExceedsBudget, sessionFilePath } from "./session-reset.js";
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

/**
 * Streaming bubble size cap (ADR-0047): a single Telegram message may hold
 * TELEGRAM_TEXT_LIMIT (4096) chars; edit the bubble to a safe margin below
 * that so a forked reply + reset notice never trips the API limit.
 */
const STREAM_BUBBLE_MAX_LENGTH = 4_000;

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
	private readonly streamJournal: StreamJournal | undefined;
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
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.transport.onMessage((msg) => void this.enqueue(msg));
		this.cron?.start();
		await this.transport.connect();
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
	 * Fan one message out to every configured deliverTo channel — across
	 * transports when a target names one (ADR-0023), else the active transport
	 * (ADR-0022). Returns how many channels were targeted.
	 */
	async deliverToAll(text: string): Promise<{ channels: number }> {
		const config = loadGatewayConfig(this.axiomHomeDir);
		const targets = config.deliverTo ?? [];
		await this.withPollingPaused(async () => {
			for (const target of targets) {
				// Resolve the actual transport first: a named target we do not hold
				// degrades to the active transport, and the ledger labels what really
				// delivered (never a phantom transport name).
				const named = target.transport !== undefined ? this.transports[target.transport] : undefined;
				const transport = named ?? this.transport;
				const name = named !== undefined ? target.transport! : this.transportName;
				await this.deliverVia(transport, name, { channelId: target.channel, recipient: "" }, text);
			}
		});
		return { channels: targets.length };
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
			if (ctx.restartRequested) this.restart?.();
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
		// Session budget: a channel session that has grown past the soft cap
		// makes every reply re-process a huge context (minute-scale latency
		// before the first word). Instead of archiving (which wipes the
		// conversation's memory), request a pre-run compaction: the completion
		// child summarizes the existing context, so the reply resumes on a
		// small session while /search still indexes the full history.
		let compactBefore = false;
		if (this.sessionsDir) {
			const path = sessionFilePath(this.sessionsDir, sessionKey);
			if (sessionExceedsBudget(path)) {
				compactBefore = true;
			}
		}
		const recipient = { channelId: msg.channelId, recipient: msg.sender };
		const input = {
			sessionId,
			prompt: msg.text,
			profile: { name: this.profile },
			model: this.modelStore?.load(),
			...(anchoredRoot ? { projectRoot: anchoredRoot } : {}),
			...(compactBefore ? { compactBefore: true } : {}),
		};
		// Replies go out while the receive loop must hold (ADR-0039): Telegram
		// queues outbound calls behind an open long-poll, so an edit would hang
		// for the whole poll window. Pause before any delivery, resume after
		// (withPollingPaused resumes even when a run throws).
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
					const journaledBubbles: number[] = [];
					try {
						messageId = await sendMessage(recipient, "…");
						journaledBubbles.push(messageId);
						this.streamJournal?.add({ channelId: msg.channelId, messageId, startedAt: Date.now() });
						// Long replies stream across several bubbles (ADR-0047):
						// Telegram caps a message at TELEGRAM_TEXT_LIMIT chars, so
						// when the accumulated text crosses the cap the editor
						// commits the current bubble and calls `rollover`, which
						// sends a fresh placeholder and re-points messageId. The
						// edit closure reads messageId at call time, so after a
						// rollover every subsequent edit targets the new bubble.
						const editor = new StreamEditor({
							edit: (text) => editMessage(msg.channelId, messageId!, text),
							minIntervalMs: STREAM_EDIT_MIN_INTERVAL_MS,
							maxTextLength: STREAM_BUBBLE_MAX_LENGTH,
							rollover: async () => {
								const nextId = await sendMessage(recipient, "…");
								journaledBubbles.push(nextId);
								this.streamJournal?.add({
									channelId: msg.channelId,
									messageId: nextId,
									startedAt: Date.now(),
								});
								messageId = nextId;
							},
						});
						// The bubble starts empty; compaction (if requested) already
						// summarized the session before the run began.
						let lastText = "";
						const streamed = await this.completion.streamCompletion(input, (delta) => {
							if (lastText === "") stopTyping(); // text is flowing; stop pinging
							lastText += delta;
							editor.setTarget(lastText);
						});
						const baseFinal =
							streamed.error !== undefined
								? `could not run the agent: ${streamed.error}`
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
						// up beyond the last bubble window). Deliver fresh messages
						// (chunked) so the answer always reaches the user.
						if (!landed || editor.remainingText().length === 0) {
							await this.deliver(recipient, finalText);
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
						for (const id of journaledBubbles) {
							this.streamJournal?.remove(msg.channelId, id);
						}
					}
					return;
				} catch {
					/* fall through to batch — the placeholder send itself failed */
				}
			}
			const stopTyping = this.startTyping(recipient);
			try {
				const result = await this.completion.runCompletion(input);
				if (result.error) {
					await this.deliver(recipient, `could not run the agent: ${result.error}`);
					return;
				}
				await this.deliver(recipient, `${result.reply.length > 0 ? result.reply : "(no reply)"}`);
			} finally {
				stopTyping();
			}
		});
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
