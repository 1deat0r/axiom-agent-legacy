/**
 * `axiom gateway` — the messaging gateway surface (ADR-0001/0004/0006, first
 * transport: Signal). Boots a profile's identity under Signal (via signal-cli)
 * and routes messages to agent completions or gateway-local commands.
 * Returns true when the invocation was a gateway command (and it ran or
 * printed usage); the process is kept alive while the gateway runs.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveProfile } from "../extensions/profile/registry.js";
import { JsonChannelIndex } from "../gateway/channel-index.js";
import { CliCompletionRunner } from "../gateway/completion.js";
import { loadGatewayConfig } from "../gateway/config.js";
import { Gateway } from "../gateway/gateway.js";
import { CliSignalClient, SignalTransport } from "../gateway/transports/signal.js";

export const GATEWAY_USAGE =
	"axiom gateway [--profile <name>] [--transport signal] [--signal-cli <path>] [--signal-account <acct>]";

function readVal(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Handle `axiom gateway ...`; returns true if it was a gateway invocation. */
export async function handleGatewayCommand(
	args: string[],
	io: { start(profile: string): Promise<Gateway> } = {
		start: defaultGatewayStart,
	},
): Promise<boolean> {
	if (args[0] !== "gateway") return false;
	if (args.includes("--help") || args.includes("-h")) {
		console.log(
			`${GATEWAY_USAGE}\n\nThe axiom assistant over Signal (signal-cli): the active profile's\nSOUL.md rides the prompt; gateway-local commands (/help, /profiles,\n/projects, /soul) never reach the model. Configure senders in\n<AXIOM_HOME>/gateway/config.json.`,
		);
		return true;
	}
	const profile = readVal(args, "--profile") ?? "default";
	const gateway = await io.start(profile);
	// Keep the process alive; the transport's receive loop owns delivery.
	// SIGINT/SIGTERM handled by the host; the gateway stays until then.
	await new Promise<void>((resolve) => {
		process.once("SIGINT", () => void gateway.stop().finally(resolve));
		process.once("SIGTERM", () => void gateway.stop().finally(resolve));
	});
	return true;
}

/** Default gateway start: Signal transport + JSON channel index + CLI runner. */
export async function defaultGatewayStart(profile: string): Promise<Gateway> {
	const { axiomHome: home } = resolveProfile(profile);
	mkdirSync(join(home, "gateway"), { recursive: true });
	const cli = new CliSignalClient();
	const index = new JsonChannelIndex(join(home, "gateway"));
	const completion = new CliCompletionRunner();
	const transport = new SignalTransport(cli);
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
