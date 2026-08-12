/**
 * `axiom gateway` — the messaging gateway surface (ADR-0001/0004/0006;
 * transports: Signal ADR-0016, Telegram ADR-0017). Boots a profile's identity
 * under a transport and routes messages to agent completions or gateway-local
 * commands. Returns true when the invocation was a gateway command (and it ran
 * or printed usage); the process is kept alive while the gateway runs.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveProfile } from "../extensions/profile/registry.js";
import { JsonChannelIndex } from "../gateway/channel-index.js";
import { CliCompletionRunner } from "../gateway/completion.js";
import { loadGatewayConfig } from "../gateway/config.js";
import { Gateway } from "../gateway/gateway.js";
import { CliSignalClient, SignalTransport } from "../gateway/transports/signal.js";
import { FileTelegramOffsetStore, HttpTelegramClient, TelegramTransport } from "../gateway/transports/telegram.js";
import type { GatewayTransport } from "../gateway/types.js";

export const GATEWAY_USAGE =
	"axiom gateway [--profile <name>] [--transport signal|telegram] [--telegram-token <token>] [--signal-cli <path>] [--signal-account <acct>]";

export interface GatewayStartOptions {
	transport: "signal" | "telegram";
	telegramToken?: string;
}

export type GatewayStartResolution =
	| { ok: true; profile: string; opts: GatewayStartOptions }
	| { ok: false; error: string };

function readVal(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
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
	if (transportRaw !== "signal" && transportRaw !== "telegram") {
		return { ok: false, error: `unknown --transport '${transportRaw}' (expected 'signal' or 'telegram')` };
	}
	const transport = transportRaw as GatewayStartOptions["transport"];
	if (transport !== "telegram") return { ok: true, profile, opts: { transport } };
	const telegramToken = readVal(args, "--telegram-token") ?? env.AXIOM_TELEGRAM_BOT_TOKEN;
	if (!telegramToken) {
		return { ok: false, error: "--transport telegram requires --telegram-token or AXIOM_TELEGRAM_BOT_TOKEN" };
	}
	return { ok: true, profile, opts: { transport, telegramToken } };
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
			`${GATEWAY_USAGE}\n\nThe axiom assistant over Signal (signal-cli) or Telegram (Bot API): the\nactive profile's SOUL.md rides the prompt; gateway-local commands (/help,\n/profiles, /projects, /soul) never reach the model. Configure senders in\n<AXIOM_HOME>/gateway/config.json. Telegram denies unknown chats by default\n(allowlist the owner's personal chat id); never commit a bot token.`,
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

/** Default gateway start: JSON channel index + CLI runner + chosen transport. */
export async function defaultGatewayStart(profile: string, opts: GatewayStartOptions): Promise<Gateway> {
	const { axiomHome: home } = resolveProfile(profile);
	mkdirSync(join(home, "gateway"), { recursive: true });
	const index = new JsonChannelIndex(join(home, "gateway"));
	const completion = new CliCompletionRunner();
	const transport = buildTransport(opts, home);
	const config = loadGatewayConfig(home);
	const gateway = new Gateway({
		transport,
		index,
		completion,
		axiomHomeDir: home,
		profile,
		senders: config.senders,
	});
	await gateway.start();
	return gateway;
}

/** Real transport selection: telegram (Bot API) or signal (signal-cli, default). */
export function buildTransport(opts: GatewayStartOptions, axiomHomeDir: string): GatewayTransport {
	if (opts.transport === "telegram") {
		const client = new HttpTelegramClient({ token: opts.telegramToken ?? "" });
		const offsetStore = new FileTelegramOffsetStore(join(axiomHomeDir, "gateway", "telegram-offset.json"));
		return new TelegramTransport(client, { offsetStore });
	}
	return new SignalTransport(new CliSignalClient());
}
