import { describe, expect, test } from "vitest";
import {
	connectorById,
	connectorGuideLines,
	GATEWAY_CONNECTORS,
	isGatewayConnectorId,
} from "../../src/gateway/connectors.js";

describe("gateway connector registry", () => {
	test("registers the four gateway transports in CLI order", () => {
		expect(GATEWAY_CONNECTORS.map((c) => c.id)).toEqual(["signal", "telegram", "discord", "slack"]);
	});

	test("telegram, discord, and slack are token connectors matching the gateway CLI", () => {
		const byId = new Map(GATEWAY_CONNECTORS.map((c) => [c.id, c]));
		expect(byId.get("telegram")).toMatchObject({
			kind: "token",
			tokenEnvVar: "AXIOM_TELEGRAM_BOT_TOKEN",
			tokenFlag: "--telegram-token",
		});
		expect(byId.get("discord")).toMatchObject({
			kind: "token",
			tokenEnvVar: "AXIOM_DISCORD_BOT_TOKEN",
			tokenFlag: "--discord-token",
		});
		expect(byId.get("slack")).toMatchObject({
			kind: "token",
			tokenEnvVar: "AXIOM_SLACK_BOT_TOKEN",
			tokenFlag: "--slack-token",
		});
	});

	test("signal is a signal-cli connector with no bot token", () => {
		const signal = GATEWAY_CONNECTORS.find((c) => c.id === "signal");
		expect(signal?.kind).toBe("signal-cli");
		expect(signal?.tokenEnvVar).toBeUndefined();
		expect(signal?.tokenFlag).toBeUndefined();
	});

	test("every connector carries a credential hint", () => {
		for (const connector of GATEWAY_CONNECTORS) {
			expect(connector.credentialHint.length).toBeGreaterThan(10);
		}
	});

	test("isGatewayConnectorId accepts the four ids and rejects lookalikes", () => {
		for (const id of ["signal", "telegram", "discord", "slack"]) {
			expect(isGatewayConnectorId(id)).toBe(true);
		}
		expect(isGatewayConnectorId("whatsapp")).toBe(false);
		expect(isGatewayConnectorId("Telegram")).toBe(false);
		expect(isGatewayConnectorId(undefined)).toBe(false);
	});

	test("connectorById resolves ids and returns undefined for unknowns", () => {
		expect(connectorById("telegram")?.label).toBe("Telegram");
		expect(connectorById("nope")).toBeUndefined();
	});

	test("connectorGuideLines names the token env var and the gateway run command", () => {
		const lines = connectorGuideLines(connectorById("discord")!);
		expect(lines.join("\n")).toContain("AXIOM_DISCORD_BOT_TOKEN");
		expect(lines.join("\n")).toContain("axiom gateway --transport discord");
		expect(lines.join("\n")).toContain("--discord-token");
	});

	test("signal guide lines point at signal-cli link and the signal run command", () => {
		const lines = connectorGuideLines(connectorById("signal")!);
		expect(lines.join("\n")).toContain("signal-cli link");
		expect(lines.join("\n")).toContain("axiom gateway --transport signal");
	});
});
