/**
 * `axiom gateway` — the messaging gateway surface (ADR-0001/0004/0006;
 * transports: Signal ADR-0016, Telegram ADR-0017). Boots a profile's identity
 * under a transport and routes messages to agent completions or gateway-local
 * commands. Returns true when the invocation was a gateway command (and it ran
 * or printed usage); the process is kept alive while the gateway runs.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCronJobsPath } from "../config.js";
import { DEFAULT_SCHEDULE_POLL_MS } from "../core/schedule/index.js";
import { axiomHome } from "../extensions/profile/registry.js";
import { activeModelPath, FileActiveModelStore } from "../gateway/active-model.js";
import { JsonChannelIndex } from "../gateway/channel-index.js";
import { CliCompletionRunner } from "../gateway/completion.js";
import { loadGatewayConfig } from "../gateway/config.js";
import { GatewayCron } from "../gateway/cron.js";
import { FileDeliveryLedger } from "../gateway/delivery-ledger.js";
import { Gateway } from "../gateway/gateway.js";
import { FileRestartNoticeStore, restartNoticePath } from "../gateway/restart-notice.js";
import { FileStreamJournal, recoverInterruptedStreams, streamJournalPath } from "../gateway/stream-journal.js";
import { DiscordTransport, FileDiscordCursorStore, HttpDiscordClient } from "../gateway/transports/discord.js";
import { CliSignalClient, SignalTransport } from "../gateway/transports/signal.js";
import { FileSlackCursorStore, HttpSlackClient, SlackTransport } from "../gateway/transports/slack.js";
import {
	defaultSlackSocketFactory,
	isSlackSocketModeEnabled,
	SLACK_SOCKET_MAX_FRAME_CHARS,
	SLACK_SOCKET_RECONNECT_MS,
	type SlackSocketApi,
	SlackSocketTransport,
} from "../gateway/transports/slack-socket.js";
import { FileTelegramOffsetStore, HttpTelegramClient, TelegramTransport } from "../gateway/transports/telegram.js";
import type { GatewayTransport } from "../gateway/types.js";

export const GATEWAY_USAGE =
	"axiom gateway [--profile <name>] [--project <name>] [--transport signal|telegram|discord|slack] [--telegram-token <token>] [--discord-token <token>] [--slack-token <token>] [--slack-app-token <token>] [--signal-cli <path>] [--signal-account <acct>] [--update-repo <path>]";

export interface GatewayStartOptions {
	transport: "signal" | "telegram" | "discord" | "slack";
	telegramToken?: string;
	/** --discord-token <token> (required for the discord transport). */
	discordToken?: string;
	/** --slack-token <token> (required for the slack transport). */
	slackToken?: string;
	/** --slack-app-token <xapp token> — required when SLACK_SOCKET_MODE is on. */
	slackAppToken?: string;
	/** SLACK_SOCKET_MODE on: receive over the Socket Mode websocket, not REST poll. */
	slackSocketMode?: boolean;
	/** signal-cli binary path (default "signal-cli" on PATH). */
	signalCliPath?: string;
	/** The linked signal-cli account to send/receive under (E.164). */
	signalAccount?: string;
	/** Anchor the run to a project under the profile's workspace (rung-3 guard). */
	project?: string;
	/** Git worktree to self-update from (/update, ADR-0034); inert unless set. */
	updateRepo?: string;
}

export type GatewayStartResolution =
	| { ok: true; profile: string; opts: GatewayStartOptions }
	| { ok: false; error: string };

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function readVal(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Non-negative integer env override with a fallback (gateway resilience knobs). */
function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Resolve how the gateway boots from the CLI args: which transport and (for
 * telegram) which token. Unknown transport values error out rather than
 * silently booting Signal, and telegram with no token fails fast — the inert
 * `--signal-account` gap from the Signal feature is not repeated here.
 */
export function resolveGatewayStart(
	args: string[],
	env: Record<string, string | undefined> = process.env,
): GatewayStartResolution {
	const profile = readVal(args, "--profile") ?? "default";
	const transportRaw = readVal(args, "--transport") ?? "signal";
	if (
		transportRaw !== "signal" &&
		transportRaw !== "telegram" &&
		transportRaw !== "discord" &&
		transportRaw !== "slack"
	) {
		return {
			ok: false,
			error: `unknown --transport '${transportRaw}' (expected 'signal', 'telegram', 'discord' or 'slack')`,
		};
	}
	const transport = transportRaw as GatewayStartOptions["transport"];
	const signalCliPath = readVal(args, "--signal-cli");
	const signalAccount = readVal(args, "--signal-account");
	const project = readVal(args, "--project");
	const updateRepo = readVal(args, "--update-repo") ?? env.AXIOM_UPDATE_REPO;
	if (project !== undefined && !PROJECT_NAME_RE.test(project)) {
		return { ok: false, error: `invalid --project '${project}' (lowercase a-z0-9 and dashes)` };
	}
	if (transport === "slack") {
		const slackToken = readVal(args, "--slack-token") ?? env.AXIOM_SLACK_BOT_TOKEN;
		if (!slackToken) {
			return { ok: false, error: "--transport slack requires --slack-token or AXIOM_SLACK_BOT_TOKEN" };
		}
		// Socket Mode (ADR-0062): opt in via SLACK_SOCKET_MODE; the app-level
		// token opens the websocket while the bot token keeps sending. REST-poll
		// receive stays the default when the gate is unset.
		if (isSlackSocketModeEnabled(env)) {
			const slackAppToken = readVal(args, "--slack-app-token") ?? env.AXIOM_SLACK_APP_TOKEN;
			if (!slackAppToken) {
				return {
					ok: false,
					error: "SLACK_SOCKET_MODE requires AXIOM_SLACK_APP_TOKEN (an app-level xapp- token) or --slack-app-token",
				};
			}
			return {
				ok: true,
				profile,
				opts: { transport, slackToken, slackAppToken, slackSocketMode: true, project, updateRepo },
			};
		}
		return { ok: true, profile, opts: { transport, slackToken, project, updateRepo } };
	}
	if (transport === "discord") {
		const discordToken = readVal(args, "--discord-token") ?? env.AXIOM_DISCORD_BOT_TOKEN;
		if (!discordToken) {
			return { ok: false, error: "--transport discord requires --discord-token or AXIOM_DISCORD_BOT_TOKEN" };
		}
		return { ok: true, profile, opts: { transport, discordToken, project, updateRepo } };
	}
	if (transport !== "telegram") {
		return { ok: true, profile, opts: { transport, signalCliPath, signalAccount, project, updateRepo } };
	}
	const telegramToken = readVal(args, "--telegram-token") ?? env.AXIOM_TELEGRAM_BOT_TOKEN;
	if (!telegramToken) {
		return { ok: false, error: "--transport telegram requires --telegram-token or AXIOM_TELEGRAM_BOT_TOKEN" };
	}
	return { ok: true, profile, opts: { transport, telegramToken, project, updateRepo } };
}

/** Handle `axiom gateway ...`; returns true if it was a gateway invocation. */
export async function handleGatewayCommand(
	args: string[],
	io: { start(profile: string, opts: GatewayStartOptions): Promise<Gateway> } = {
		start: defaultGatewayStart,
	},
): Promise<boolean> {
	if (args[0] !== "gateway") return false;
	if (args.includes("--help") || args.includes("-h")) {
		console.log(
			`${GATEWAY_USAGE}\n\nThe axiom assistant over Signal (signal-cli), Telegram, Discord, or Slack\n(Bot/Web API): the active profile's SOUL.md rides the prompt; gateway-local\ncommands (/help, /profiles, /projects, /soul) never reach the model. Configure\nsenders in <AXIOM_HOME>/gateway/config.json. Telegram, Discord, and Slack deny unknown\nsenders by default (allowlist the owner's personal chat / user id); never\ncommit a bot token. Slack receive is REST long-poll by default; set\nSLACK_SOCKET_MODE=1 with AXIOM_SLACK_APP_TOKEN to receive over Socket Mode.`,
		);
		return true;
	}
	const resolution = resolveGatewayStart(args);
	if (!resolution.ok) {
		console.error(resolution.error);
		console.log(GATEWAY_USAGE);
		return true;
	}
	const gateway = await io.start(resolution.profile, resolution.opts);
	// Keep the process alive; the transport's receive loop owns delivery.
	// SIGINT/SIGTERM handled by the host; the gateway stays until then.
	await new Promise<void>((resolve) => {
		process.once("SIGINT", () => void gateway.stop().finally(resolve));
		process.once("SIGTERM", () => void gateway.stop().finally(resolve));
	});
	return true;
}

/**
 * Default gateway start: JSON channel index + CLI runner + chosen transport.
 * `axiomHomeDir` is the AXIOM ROOT (~/.axiom) — where the shared gateway
 * config + channel index live (ADR-0016/17). The active profile's home is
 * projectHome: the root itself for the implicit 'default' profile, else
 * profiles/<name> (ADR-0014).
 */
/**
 * The sessions archive directory for the active profile: named profiles keep
 * their agent dir at the profile home, the implicit `default` profile uses the
 * base agent dir (~/.axiom/agent). Both hold sessions/<id>.jsonl.
 */
export function resolveSessionsDir(profile: string, projectHome: string): string {
	return profile === "default" ? join(homedir(), ".axiom", "agent", "sessions") : join(projectHome, "sessions");
}

/**
 * The persistent cross-session recall index: a sqlite file under the axiom
 * home's search dir, isolated per profile home (writable, like the memory store).
 */
export function resolveSearchIndexPath(axiomHomeDir: string): string {
	return join(axiomHomeDir, "search", "session-recall.sqlite");
}

export async function defaultGatewayStart(profile: string, opts: GatewayStartOptions): Promise<Gateway> {
	const root = axiomHome();
	const projectHome = profile === "default" ? root : join(axiomHome(), "profiles", profile);
	mkdirSync(join(root, "gateway"), { recursive: true });
	const index = new JsonChannelIndex(join(root, "gateway"));
	let projectRoot: string | undefined;
	if (opts.project) {
		projectRoot = join(projectHome, "projects", opts.project);
		if (!existsSync(projectRoot)) {
			throw new Error(
				`--project '${opts.project}' not found under the profile workspace (${projectRoot}) \u2014 create it with /projects add first`,
			);
		}
	}
	const completion = new CliCompletionRunner({
		projectRoot,
		timeoutMs: envInt("GATEWAY_COMPLETION_TIMEOUT_MS", 300_000),
		compactTimeoutMs: envInt("GATEWAY_COMPACT_TIMEOUT_MS", 600_000),
	});
	const transport = buildTransport(opts, root);
	// Boot recovery (streaming v2): edit any bubble a previous process left
	// mid-stream into an interruption notice, so a restart never strands a
	// silent "…". No-op on transports without in-place edits.
	const streamJournal = new FileStreamJournal(streamJournalPath(root));
	await recoverInterruptedStreams(transport, streamJournal);
	const config = loadGatewayConfig(root);
	// One shared ledger records every outbound delivery — interactive replies,
	// /announce fan-out, and scheduled cron-run deliveries alike (ADR-0022).
	const ledger = new FileDeliveryLedger(join(root, "gateway", "ledger.jsonl"));
	// Profile-scoped cron store: reuse the baseline AgentCronJobStore format at
	// the profile home (default profile = the axiom root). The manager's
	// scheduler fires /cron jobs and delivers their output to the job's channel
	// via the same transport used for interactive replies, recorded in `ledger`.
	const cron = new GatewayCron({
		storePath: getCronJobsPath(projectHome),
		completion,
		transport,
		profile,
		projectHome,
		ledger,
		transportName: opts.transport,
	});
	const gateway = new Gateway({
		transport,
		index,
		completion,
		axiomHomeDir: root,
		profile,
		projectHome,
		sessionsDir: resolveSessionsDir(profile, projectHome),
		searchIndexPath: resolveSearchIndexPath(root),
		projectRoot,
		senders: config.senders,
		cron,
		ledger,
		streamJournal,
		// Model-facing schedule (ADR-0053): the reminder store is shared with
		// the completion children under the axiom home's gateway dir, and the
		// gateway sweeps it on boot and every GATEWAY_SCHEDULE_POLL_MS.
		schedule: {
			storePath: join(root, "gateway", "schedule.jsonl"),
			pollMs: envInt("GATEWAY_SCHEDULE_POLL_MS", DEFAULT_SCHEDULE_POLL_MS),
		},
		transportName: opts.transport,
		modelStore: new FileActiveModelStore(activeModelPath(root, profile)),
		restartNoticeStore: new FileRestartNoticeStore(restartNoticePath(root)),
		transports: buildFanOutTransports(opts, root),
		...(opts.updateRepo ? { update: { repoDir: opts.updateRepo } } : {}),
		// The update path only fires on an explicit, successful /update now —
		// systemd `Restart=always` brings the service back on the new bundle.
		restart: () => process.exit(0),
		// Completion resilience (ADR-0050): transient child failures retry
		// once (without compaction); a restart waits for in-flight runs.
		completionRetries: envInt("GATEWAY_COMPLETION_RETRIES", 1),
		completionRetryDelayMs: envInt("GATEWAY_COMPLETION_RETRY_DELAY_MS", 5_000),
		restartGraceMs: envInt("GATEWAY_RESTART_GRACE_MS", 30_000),
	});
	await gateway.start();
	return gateway;
}

/** Real transport selection: telegram (Bot API) or signal (signal-cli, default). */
export function buildTransport(opts: GatewayStartOptions, axiomHomeDir: string): GatewayTransport {
	if (opts.transport === "slack") {
		const slackToken = opts.slackToken ?? "";
		if (opts.slackSocketMode === true) {
			// Socket Mode receive: the app token opens the websocket link, the
			// bot token still sends. resolveGatewayStart already failed fast for
			// a missing app token; an empty token here is a programming error.
			const appToken = opts.slackAppToken ?? "";
			if (appToken === "") {
				throw new Error("SLACK_SOCKET_MODE requires a slack app token (AXIOM_SLACK_APP_TOKEN)");
			}
			const botClient = new HttpSlackClient({ token: slackToken });
			const appClient = new HttpSlackClient({ token: appToken });
			const api: SlackSocketApi = {
				appsConnectionsOpen: () => appClient.appsConnectionsOpen(),
				postMessage: (input) => botClient.postMessage(input),
			};
			return new SlackSocketTransport(api, {
				secrets: [appToken, slackToken],
				reconnectDelayMs: envInt("SLACK_SOCKET_RECONNECT_MS", SLACK_SOCKET_RECONNECT_MS),
				maxFrameChars: envInt("SLACK_SOCKET_MAX_FRAME_CHARS", SLACK_SOCKET_MAX_FRAME_CHARS),
				socketFactory: defaultSlackSocketFactory,
			});
		}
		const client = new HttpSlackClient({ token: slackToken });
		const cursorStore = new FileSlackCursorStore(join(axiomHomeDir, "gateway", "slack-cursor.json"));
		return new SlackTransport(client, { cursorStore });
	}
	if (opts.transport === "discord") {
		const client = new HttpDiscordClient({ token: opts.discordToken ?? "" });
		const cursorStore = new FileDiscordCursorStore(join(axiomHomeDir, "gateway", "discord-cursor.json"));
		return new DiscordTransport(client, { cursorStore });
	}
	if (opts.transport === "telegram") {
		const client = new HttpTelegramClient({ token: opts.telegramToken ?? "" });
		const offsetStore = new FileTelegramOffsetStore(join(axiomHomeDir, "gateway", "telegram-offset.json"));
		return new TelegramTransport(client, {
			offsetStore,
			dedupWindowMs: envInt("GATEWAY_MESSAGE_DEDUP_MS", 600_000),
		});
	}
	// Signal: wire the operator's --signal-cli path and linked --signal-account
	// so the one-command live test targets the right (shared) account.
	return new SignalTransport(new CliSignalClient(opts.signalCliPath ?? "signal-cli", opts.signalAccount));
}

/** Build ONE named fan-out transport for `t` from its token. */
function buildFanOutTransport(t: "telegram" | "discord" | "slack", token: string, root: string): GatewayTransport {
	if (t === "telegram") return buildTransport({ transport: "telegram", telegramToken: token }, root);
	if (t === "discord") return buildTransport({ transport: "discord", discordToken: token }, root);
	return buildTransport({ transport: "slack", slackToken: token }, root);
}

/**
 * Extra send-only transports for cross-platform fan-out (ADR-0023): every
 * platform OTHER than the active transport whose token is present in the
 * environment is built so a deliverTo entry naming that transport can reach
 * it. A platform with no token is simply absent — graceful, never guessed.
 */
export function buildFanOutTransports(
	opts: GatewayStartOptions,
	root: string,
	env: Record<string, string | undefined> = process.env,
): Record<string, GatewayTransport> {
	const out: Record<string, GatewayTransport> = {};
	const candidates: Array<[t: "telegram" | "discord" | "slack", token: string | undefined]> = [
		["telegram", env.AXIOM_TELEGRAM_BOT_TOKEN ?? opts.telegramToken],
		["discord", env.AXIOM_DISCORD_BOT_TOKEN ?? opts.discordToken],
		["slack", env.AXIOM_SLACK_BOT_TOKEN ?? opts.slackToken],
	];
	for (const [t, token] of candidates) {
		if (t === opts.transport) continue; // the active transport is the primary
		if (!token) continue; // operator hasn't enabled this platform
		out[t] = buildFanOutTransport(t, token, root);
	}
	return out;
}
