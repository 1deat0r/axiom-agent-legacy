/**
 * Gateway connector registry (ADR-0036): the four transports the messaging
 * gateway can run under and the credential each needs. Pure data + helpers,
 * shared by the terminal `/connectors` menu and the gateway CLI surfaces.
 */

/** The transports `axiom gateway --transport <id>` boots under (ADR-0016/17/20/21). */
export type GatewayConnectorId = "signal" | "telegram" | "discord" | "slack";

export interface GatewayConnector {
	id: GatewayConnectorId;
	/** Display label, e.g. "Telegram". */
	label: string;
	/** Token connectors boot with a bot token env var; signal boots with signal-cli. */
	kind: "token" | "signal-cli";
	/** The env var that carries the bot token (token connectors only). */
	tokenEnvVar?: string;
	/** The `axiom gateway` flag for the same token (token connectors only). */
	tokenFlag?: string;
	/** Where the operator obtains the credential. */
	credentialHint: string;
}

export const GATEWAY_CONNECTORS: ReadonlyArray<GatewayConnector> = [
	{
		id: "signal",
		label: "Signal",
		kind: "signal-cli",
		credentialHint:
			"link this machine with signal-cli (`signal-cli link` and scan the QR code) so the gateway sends and receives under the linked number",
	},
	{
		id: "telegram",
		label: "Telegram",
		kind: "token",
		tokenEnvVar: "AXIOM_TELEGRAM_BOT_TOKEN",
		tokenFlag: "--telegram-token",
		credentialHint: "message @BotFather on Telegram and create a new bot to get the bot token",
	},
	{
		id: "discord",
		label: "Discord",
		kind: "token",
		tokenEnvVar: "AXIOM_DISCORD_BOT_TOKEN",
		tokenFlag: "--discord-token",
		credentialHint: "create an app at discord.com/developers, add a bot, and copy its token",
	},
	{
		id: "slack",
		label: "Slack",
		kind: "token",
		tokenEnvVar: "AXIOM_SLACK_BOT_TOKEN",
		tokenFlag: "--slack-token",
		credentialHint:
			"create an app at api.slack.com/apps and install it to your workspace to get the Bot User OAuth token",
	},
];

const CONNECTOR_ID_SET: ReadonlySet<string> = new Set(GATEWAY_CONNECTORS.map((connector) => connector.id));

export function isGatewayConnectorId(value: unknown): value is GatewayConnectorId {
	return typeof value === "string" && CONNECTOR_ID_SET.has(value);
}

export function connectorById(id: string): GatewayConnector | undefined {
	return GATEWAY_CONNECTORS.find((connector) => connector.id === id);
}

/** One-line setup guide for a connector: credential, where to get it, how to run. */
export function connectorGuideLines(connector: GatewayConnector): string[] {
	const lines = [`${connector.label} (${connector.id})`];
	if (connector.kind === "token") {
		lines.push(`  credential: ${connector.tokenEnvVar} (or pass ${connector.tokenFlag} to the gateway)`);
		lines.push(`  get one: ${connector.credentialHint}`);
		lines.push(`  run: axiom gateway --transport ${connector.id} --profile default`);
	} else {
		lines.push(`  credential: a signal-cli account linked on this machine (no bot token)`);
		lines.push(`  get one: ${connector.credentialHint}`);
		lines.push(
			`  run: axiom gateway --transport signal [--signal-cli <path>] [--signal-account <number>] --profile default`,
		);
	}
	return lines;
}
