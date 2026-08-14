/**
 * Socket Mode selection (issue #40): SLACK_SOCKET_MODE=1 swaps the slack
 * transport's receive path to Socket Mode (websocket) behind the env gate;
 * REST-poll receive stays the default when the gate is unset. Fails fast
 * when the app-level token (AXIOM_SLACK_APP_TOKEN) is missing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTransport, resolveGatewayStart } from "../../src/cli/gateway-command.js";
import { SlackTransport } from "../../src/gateway/transports/slack.js";
import { SlackSocketTransport } from "../../src/gateway/transports/slack-socket.js";

describe("resolveGatewayStart slack socket mode (env gate)", () => {
	it("selects socket mode when SLACK_SOCKET_MODE is on and the app token is present", () => {
		const r = resolveGatewayStart(["gateway", "--transport", "slack", "--slack-token", "BOT"], {
			SLACK_SOCKET_MODE: "1",
			AXIOM_SLACK_APP_TOKEN: "xapp-APP",
		});
		expect(r).toEqual({
			ok: true,
			profile: "default",
			opts: { transport: "slack", slackToken: "BOT", slackAppToken: "xapp-APP", slackSocketMode: true },
		});
	});

	it("keeps REST-poll receive as the default when SLACK_SOCKET_MODE is unset", () => {
		const r = resolveGatewayStart(["gateway", "--transport", "slack", "--slack-token", "BOT"], {});
		expect(r).toEqual({
			ok: true,
			profile: "default",
			opts: { transport: "slack", slackToken: "BOT" },
		});
	});

	it("treats non-truthy SLACK_SOCKET_MODE values as off", () => {
		for (const value of ["0", "no", "", "off"]) {
			const r = resolveGatewayStart(["gateway", "--transport", "slack", "--slack-token", "BOT"], {
				SLACK_SOCKET_MODE: value,
			});
			expect(r).toEqual({
				ok: true,
				profile: "default",
				opts: { transport: "slack", slackToken: "BOT" },
			});
		}
	});

	it("fails fast when socket mode is on but the app token is missing", () => {
		const r = resolveGatewayStart(["gateway", "--transport", "slack", "--slack-token", "BOT"], {
			SLACK_SOCKET_MODE: "1",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("AXIOM_SLACK_APP_TOKEN");
	});

	it("accepts the app token from the --slack-app-token flag", () => {
		const r = resolveGatewayStart(
			["gateway", "--transport", "slack", "--slack-token", "BOT", "--slack-app-token", "xapp-FLAG"],
			{ SLACK_SOCKET_MODE: "1" },
		);
		expect(r).toEqual({
			ok: true,
			profile: "default",
			opts: { transport: "slack", slackToken: "BOT", slackAppToken: "xapp-FLAG", slackSocketMode: true },
		});
	});
});

describe("buildTransport slack socket mode", () => {
	it("builds a SlackSocketTransport when socket mode is on", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-sm-"));
		try {
			const t = buildTransport(
				{ transport: "slack", slackToken: "BOT", slackAppToken: "xapp-APP", slackSocketMode: true },
				dir,
			);
			expect(t).toBeInstanceOf(SlackSocketTransport);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps the REST-poll SlackTransport by default", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-sm-"));
		try {
			const t = buildTransport({ transport: "slack", slackToken: "BOT" }, dir);
			expect(t).toBeInstanceOf(SlackTransport);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("throws when socket mode is on but the app token is empty", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-sm-"));
		try {
			expect(() => buildTransport({ transport: "slack", slackToken: "BOT", slackSocketMode: true }, dir)).toThrow(
				/APP_TOKEN|app token/,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
