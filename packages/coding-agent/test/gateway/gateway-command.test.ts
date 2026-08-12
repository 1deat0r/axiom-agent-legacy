import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildFanOutTransports,
	buildTransport,
	defaultGatewayStart,
	handleGatewayCommand,
	resolveGatewayStart,
} from "../../src/cli/gateway-command.js";
import { DiscordTransport } from "../../src/gateway/transports/discord.js";
import { SignalTransport } from "../../src/gateway/transports/signal.js";
import { SlackTransport } from "../../src/gateway/transports/slack.js";
import { TelegramTransport } from "../../src/gateway/transports/telegram.js";

describe("resolveGatewayStart (transport selection)", () => {
	it("defaults to the signal transport when --transport is absent", () => {
		expect(resolveGatewayStart(["gateway"])).toEqual({
			ok: true,
			profile: "default",
			opts: { transport: "signal" },
		});
	});

	it("carries the operator's --signal-account and --signal-cli into the signal start", () => {
		const r = resolveGatewayStart([
			"gateway",
			"--signal-account",
			"+64272811798",
			"--signal-cli",
			"/usr/local/bin/signal-cli",
		]);
		expect(r).toEqual({
			ok: true,
			profile: "default",
			opts: { transport: "signal", signalCliPath: "/usr/local/bin/signal-cli", signalAccount: "+64272811798" },
		});
	});

	it("selects telegram from the --telegram-token flag", () => {
		expect(resolveGatewayStart(["gateway", "--transport", "telegram", "--telegram-token", "TOK"])).toEqual({
			ok: true,
			profile: "default",
			opts: { transport: "telegram", telegramToken: "TOK" },
		});
	});

	it("selects telegram from AXIOM_TELEGRAM_BOT_TOKEN when no flag is given", () => {
		expect(
			resolveGatewayStart(["gateway", "--transport", "telegram"], { AXIOM_TELEGRAM_BOT_TOKEN: "ENVTOK" }),
		).toEqual({
			ok: true,
			profile: "default",
			opts: { transport: "telegram", telegramToken: "ENVTOK" },
		});
	});

	it("selects discord from the --discord-token flag", () => {
		expect(resolveGatewayStart(["gateway", "--transport", "discord", "--discord-token", "DTOK"])).toEqual({
			ok: true,
			profile: "default",
			opts: { transport: "discord", discordToken: "DTOK" },
		});
	});

	it("selects discord from AXIOM_DISCORD_BOT_TOKEN when no flag is given", () => {
		expect(resolveGatewayStart(["gateway", "--transport", "discord"], { AXIOM_DISCORD_BOT_TOKEN: "ENVTOK" })).toEqual(
			{
				ok: true,
				profile: "default",
				opts: { transport: "discord", discordToken: "ENVTOK" },
			},
		);
	});

	it("fails fast when discord is selected with no token", () => {
		const r = resolveGatewayStart(["gateway", "--transport", "discord"], {});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("token");
	});

	it("selects slack from the --slack-token flag", () => {
		expect(resolveGatewayStart(["gateway", "--transport", "slack", "--slack-token", "STOK"])).toEqual({
			ok: true,
			profile: "default",
			opts: { transport: "slack", slackToken: "STOK" },
		});
	});

	it("selects slack from AXIOM_SLACK_BOT_TOKEN when no flag is given", () => {
		expect(resolveGatewayStart(["gateway", "--transport", "slack"], { AXIOM_SLACK_BOT_TOKEN: "ENVTOK" })).toEqual({
			ok: true,
			profile: "default",
			opts: { transport: "slack", slackToken: "ENVTOK" },
		});
	});

	it("fails fast when slack is selected with no token", () => {
		const r = resolveGatewayStart(["gateway", "--transport", "slack"], {});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("token");
	});

	it("errors on an unknown --transport value (never silently boots Signal)", () => {
		const r = resolveGatewayStart(["gateway", "--transport", "carrier-pigeon"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("unknown --transport");
	});

	it("fails fast when telegram is selected with no token", () => {
		const r = resolveGatewayStart(["gateway", "--transport", "telegram"], {});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("token");
	});
});

describe("resolveGatewayStart (project anchor, rung 3)", () => {
	it("carries --project into the start options", () => {
		expect(resolveGatewayStart(["gateway", "--project", "acme"])).toMatchObject({
			ok: true,
			opts: { project: "acme" },
		});
	});

	it("rejects an unsafe --project name (fail fast, like the telegram token rule)", () => {
		const r = resolveGatewayStart(["gateway", "--project", "../escape"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("invalid --project");
	});
});

describe("defaultGatewayStart (project validation)", () => {
	it("fails fast when --project names a project that does not exist", async () => {
		const home = await mkdtemp(join(tmpdir(), "axiom-gwc-"));
		const prev = process.env.AXIOM_HOME;
		process.env.AXIOM_HOME = home;
		try {
			await expect(defaultGatewayStart("default", { transport: "signal", project: "nope" })).rejects.toThrow(
				/--project 'nope' not found/,
			);
		} finally {
			if (prev === undefined) delete process.env.AXIOM_HOME;
			else process.env.AXIOM_HOME = prev;
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("buildTransport", () => {
	it("builds a TelegramTransport for --transport telegram (with file offset store)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-tgc-"));
		try {
			const t = buildTransport({ transport: "telegram", telegramToken: "TOK" }, dir);
			expect(t).toBeInstanceOf(TelegramTransport);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("builds a SlackTransport for --transport slack (with file cursor store)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-slt-"));
		try {
			const t = buildTransport({ transport: "slack", slackToken: "STOK" }, dir);
			expect(t).toBeInstanceOf(SlackTransport);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("builds a DiscordTransport for --transport discord (with file cursor store)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-dtg-"));
		try {
			const t = buildTransport({ transport: "discord", discordToken: "DTOK" }, dir);
			expect(t).toBeInstanceOf(DiscordTransport);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("builds a SignalTransport by default", () => {
		expect(buildTransport({ transport: "signal" }, "/tmp")).toBeInstanceOf(SignalTransport);
	});

	it("builds a SignalTransport with the operator's signal-cli path + account", () => {
		const t = buildTransport(
			{ transport: "signal", signalCliPath: "/x/bin/signal-cli", signalAccount: "+64272811798" },
			"/tmp",
		);
		expect(t).toBeInstanceOf(SignalTransport);
	});
});

describe("handleGatewayCommand error paths", () => {
	it("returns true on an unknown transport without booting the gateway", async () => {
		let started = false;
		const handled = await handleGatewayCommand(["gateway", "--transport", "carrier-pigeon"], {
			start: async () => {
				started = true;
				throw new Error("must not be called");
			},
		});
		expect(handled).toBe(true);
		expect(started).toBe(false);
	});

	it("returns true when telegram is selected but no token exists", async () => {
		let started = false;
		const handled = await handleGatewayCommand(["gateway", "--transport", "telegram"], {
			start: async () => {
				started = true;
				throw new Error("must not be called");
			},
		});
		expect(handled).toBe(true);
		expect(started).toBe(false);
	});
});

describe("buildFanOutTransports (cross-platform fan-out, ADR-0023)", () => {
	it("builds a sibling discord transport when its token is set and the active is telegram", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-fot-"));
		try {
			const out = buildFanOutTransports({ transport: "telegram", telegramToken: "T" }, dir, {
				AXIOM_DISCORD_BOT_TOKEN: "D",
			});
			expect(Object.keys(out)).toEqual(["discord"]);
			expect(out.discord).toBeInstanceOf(DiscordTransport);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("excludes the active transport and any platform without a token", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-fot-"));
		try {
			// Active = discord; only a slack token present -> only slack is a fan-out.
			const out = buildFanOutTransports({ transport: "discord", discordToken: "D" }, dir, {
				AXIOM_SLACK_BOT_TOKEN: "S",
			});
			expect(Object.keys(out)).toEqual(["slack"]);
			expect(out.slack).toBeInstanceOf(SlackTransport);
			// No sibling tokens -> empty map (single-platform default).
			expect(buildFanOutTransports({ transport: "signal" }, dir, {})).toEqual({});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
