import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import {
	formatConnectorStatusLines,
	type GatewayServiceDeps,
	type GatewayServiceState,
	isProcessInServiceCgroup,
	parseUnitTokenVars,
	parseUnitTransport,
	readGatewayConnectorStatus,
	readGatewayServiceState,
	rewriteUnitTransport,
	runConnectorsCommandArgs,
	setConnectorToken,
	setEnvFileLine,
	setUnitEnvLine,
	switchGatewayTransport,
} from "../src/cli/gateway-service.js";
import { connectorById } from "../src/gateway/connectors.js";

const TELEGRAM_UNIT = `[Unit]
Description=Axiom Telegram gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/mustbearn/Projects/axiom-agent/packages/coding-agent
ExecStart=/usr/bin/node --require /home/mustbearn/Projects/axiom-agent/node_modules/tsx/dist/preflight.cjs --import file:///home/mustbearn/Projects/axiom-agent/node_modules/tsx/dist/loader.mjs /home/mustbearn/Projects/axiom-agent/packages/coding-agent/src/main.ts gateway --transport telegram --profile default
Environment=AXIOM_HOME=/home/mustbearn/.axiom
Environment=AXIOM_TELEGRAM_BOT_TOKEN=8990:AAE
Environment=AXIOM_UPDATE_REPO=/home/mustbearn/Projects/axiom-agent

Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;

interface FakeExecCall {
	command: string;
	args: string[];
}

function makeDeps(
	overrides: {
		unitText?: string;
		envFileText?: string;
		activeState?: string;
		fragmentPath?: string;
		execResults?: Map<string, { code: number; stdout: string; stderr: string }>;
		env?: Record<string, string | undefined>;
		cgroupText?: string;
	} = {},
): { deps: GatewayServiceDeps; execCalls: FakeExecCall[]; written: Map<string, string> } {
	const execCalls: FakeExecCall[] = [];
	const written = new Map<string, string>();
	let unitText = overrides.unitText ?? TELEGRAM_UNIT;
	let envFileText = overrides.envFileText ?? "";
	const execResults = overrides.execResults ?? new Map();
	const deps: GatewayServiceDeps = {
		serviceName: "axiom-telegram-gateway.service",
		envFilePath: "/home/mustbearn/.config/axiom-gateway.env",
		exec: async (command, args) => {
			execCalls.push({ command, args });
			const key = `${command} ${args.join(" ")}`;
			const preset = execResults.get(key);
			if (preset) return preset;
			if (command === "systemctl" && args[0] === "--user" && args[1] === "show") {
				return {
					code: 0,
					stdout: `ActiveState=${overrides.activeState ?? "active"}\nFragmentPath=${overrides.fragmentPath ?? "/home/mustbearn/.config/systemd/user/axiom-telegram-gateway.service"}\n`,
					stderr: "",
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		},
		readFile: (path) => {
			if (path === deps.envFilePath) return envFileText;
			if (path === "/proc/self/cgroup") return overrides.cgroupText ?? "";
			if (path.endsWith(".service")) return unitText;
			throw new Error(`ENOENT: ${path}`);
		},
		writeFile: (path, content) => {
			written.set(path, content);
			if (path.endsWith(".service")) unitText = content;
			if (path === deps.envFilePath) envFileText = content;
		},
		env: overrides.env ?? {},
		cgroupPath: "/proc/self/cgroup",
	};
	return { deps, execCalls, written };
}

describe("parseUnitTransport", () => {
	test("reads the space and equals forms from the ExecStart line", () => {
		expect(parseUnitTransport(TELEGRAM_UNIT)).toBe("telegram");
		expect(parseUnitTransport(TELEGRAM_UNIT.replace("--transport telegram", "--transport=discord"))).toBe("discord");
	});

	test("ignores --transport mentions outside ExecStart", () => {
		const unit = `${TELEGRAM_UNIT.replace("--transport telegram", "")}# reminder: --transport slack\n`;
		expect(parseUnitTransport(unit)).toBeUndefined();
	});

	test("returns undefined when the flag is absent", () => {
		expect(parseUnitTransport(TELEGRAM_UNIT.replace("--transport telegram", ""))).toBeUndefined();
	});
});

describe("parseUnitTokenVars", () => {
	test("collects bot-token Environment var names", () => {
		expect(parseUnitTokenVars(TELEGRAM_UNIT)).toEqual(["AXIOM_TELEGRAM_BOT_TOKEN"]);
	});

	test("handles values containing equals signs", () => {
		const unit = `${TELEGRAM_UNIT}Environment=AXIOM_DISCORD_BOT_TOKEN=a=b=c\n`;
		expect(parseUnitTokenVars(unit)).toContain("AXIOM_DISCORD_BOT_TOKEN");
	});
});

describe("rewriteUnitTransport", () => {
	test("replaces the space form in place", () => {
		const out = rewriteUnitTransport(TELEGRAM_UNIT, "discord");
		expect(parseUnitTransport(out)).toBe("discord");
		expect(out).not.toContain("--transport telegram");
	});

	test("replaces the equals form in place", () => {
		const unit = TELEGRAM_UNIT.replace("--transport telegram", "--transport=telegram");
		const out = rewriteUnitTransport(unit, "slack");
		expect(parseUnitTransport(out)).toBe("slack");
	});

	test("appends the flag when the unit has no --transport", () => {
		const unit = TELEGRAM_UNIT.replace(" --transport telegram", "");
		const out = rewriteUnitTransport(unit, "telegram");
		expect(parseUnitTransport(out)).toBe("telegram");
		expect(out).toContain("gateway --profile default --transport telegram\n");
	});

	test("leaves every other line untouched", () => {
		const out = rewriteUnitTransport(TELEGRAM_UNIT, "signal");
		const originalLines = TELEGRAM_UNIT.split("\n").filter((l) => !l.startsWith("ExecStart="));
		const outLines = out.split("\n").filter((l) => !l.startsWith("ExecStart="));
		expect(outLines).toEqual(originalLines);
	});
});

describe("setUnitEnvLine", () => {
	test("adds a new Environment line after the last existing one", () => {
		const out = setUnitEnvLine(TELEGRAM_UNIT, "AXIOM_DISCORD_BOT_TOKEN", "tok");
		const lines = out.split("\n");
		const envIndex = lines.findIndex((l) => l.startsWith("Environment=AXIOM_DISCORD_BOT_TOKEN="));
		expect(envIndex).toBeGreaterThan(-1);
		expect(lines[envIndex - 1]).toContain("Environment=AXIOM_UPDATE_REPO=");
	});

	test("replaces the value of an existing var without duplicating it", () => {
		const out = setUnitEnvLine(TELEGRAM_UNIT, "AXIOM_TELEGRAM_BOT_TOKEN", "fresh");
		expect(out.split("\n").filter((l) => l.startsWith("Environment=AXIOM_TELEGRAM_BOT_TOKEN="))).toEqual([
			"Environment=AXIOM_TELEGRAM_BOT_TOKEN=fresh",
		]);
	});
});

describe("setEnvFileLine", () => {
	test("replaces an existing KEY= line and appends new keys", () => {
		const out = setEnvFileLine("AXIOM_TELEGRAM_BOT_TOKEN=old\n# comment\n", "AXIOM_TELEGRAM_BOT_TOKEN", "new");
		expect(out).toBe("AXIOM_TELEGRAM_BOT_TOKEN=new\n# comment\n");
		const appended = setEnvFileLine(out, "AXIOM_DISCORD_BOT_TOKEN", "d");
		expect(appended).toContain("AXIOM_DISCORD_BOT_TOKEN=d");
	});
});

describe("readGatewayServiceState", () => {
	test("parses ActiveState, FragmentPath, transport, and token vars", async () => {
		const { deps } = makeDeps();
		const state = await readGatewayServiceState(deps);
		expect(state).toEqual({
			serviceName: "axiom-telegram-gateway.service",
			activeState: "active",
			fragmentPath: "/home/mustbearn/.config/systemd/user/axiom-telegram-gateway.service",
			transport: "telegram",
			unitTokenVars: ["AXIOM_TELEGRAM_BOT_TOKEN"],
		});
	});

	test("returns an empty state when systemctl cannot find the unit", async () => {
		const { deps } = makeDeps({
			execResults: new Map([
				[
					"systemctl --user show axiom-telegram-gateway.service -p ActiveState -p FragmentPath",
					{ code: 1, stdout: "", stderr: "Unit not found" },
				],
			]),
		});
		const state = await readGatewayServiceState(deps);
		expect(state).toEqual({
			serviceName: "axiom-telegram-gateway.service",
			activeState: undefined,
			fragmentPath: undefined,
			transport: undefined,
			unitTokenVars: [],
		});
	});

	test("tolerates an unreadable fragment file", async () => {
		const { deps } = makeDeps();
		const throwing = {
			...deps,
			readFile: (path: string) => {
				if (path.endsWith(".service")) throw new Error("gone");
				return deps.readFile(path);
			},
		};
		const state = await readGatewayServiceState(throwing);
		expect(state.transport).toBeUndefined();
		expect(state.fragmentPath).toBe("/home/mustbearn/.config/systemd/user/axiom-telegram-gateway.service");
	});
});

describe("readGatewayConnectorStatus", () => {
	test("marks the active transport only when the service is active", async () => {
		const { deps } = makeDeps();
		const state = await readGatewayServiceState(deps);
		const statuses = await readGatewayConnectorStatus(deps, state);
		const telegram = statuses.find((s) => s.connector.id === "telegram");
		expect(telegram).toMatchObject({ active: true, serviceRunning: true, label: "active" });
		const discord = statuses.find((s) => s.connector.id === "discord");
		expect(discord).toMatchObject({ active: false, label: "no token" });
	});

	test("detects tokens from the unit Environment, the env file, and the process env", async () => {
		const envFileText = "AXIOM_DISCORD_BOT_TOKEN=from-env-file\n";
		const { deps } = makeDeps({ envFileText, env: { AXIOM_SLACK_BOT_TOKEN: "from-process" } });
		const state = await readGatewayServiceState(deps);
		const statuses = await readGatewayConnectorStatus(deps, state);
		const byId = new Map(statuses.map((s) => [s.connector.id, s]));
		expect(byId.get("telegram")?.credentialConfigured).toBe(true);
		expect(byId.get("discord")?.label).toBe("token set");
		expect(byId.get("slack")?.label).toBe("token set");
	});

	test("does not mark a stopped service's transport active", async () => {
		const { deps } = makeDeps({ activeState: "inactive" });
		const state = await readGatewayServiceState(deps);
		const statuses = await readGatewayConnectorStatus(deps, state);
		expect(statuses.find((s) => s.connector.id === "telegram")?.label).toBe("token set");
	});

	test("reports signal-cli presence from the PATH probe", async () => {
		const { deps } = makeDeps();
		const state = await readGatewayServiceState(deps);
		const statuses = await readGatewayConnectorStatus(deps, state);
		expect(statuses.find((s) => s.connector.id === "signal")?.label).toBe("signal-cli found");
	});
});

describe("formatConnectorStatusLines", () => {
	test("leads with the service state and lists each connector", async () => {
		const { deps } = makeDeps({ activeState: "failed", env: { AXIOM_SLACK_BOT_TOKEN: "x" } });
		const state = await readGatewayServiceState(deps);
		const statuses = await readGatewayConnectorStatus(deps, state);
		const lines = formatConnectorStatusLines(state, statuses);
		expect(lines[0]).toContain("axiom-telegram-gateway.service");
		expect(lines[0]).toContain("failed");
		expect(lines.join("\n")).toContain("telegram — token set");
		expect(lines.join("\n")).toContain("slack — token set");
		expect(lines.join("\n")).toContain("discord — no token");
	});
});

describe("setConnectorToken", () => {
	test("writes the token into the unit Environment and the env file", async () => {
		const { deps, written } = makeDeps();
		const lines = await setConnectorToken(connectorById("discord")!, "DISCORD_TOKEN", deps);
		expect(lines.join("\n")).toContain("AXIOM_DISCORD_BOT_TOKEN");
		const unit = written.get("/home/mustbearn/.config/systemd/user/axiom-telegram-gateway.service")!;
		expect(parseUnitTokenVars(unit)).toContain("AXIOM_DISCORD_BOT_TOKEN");
		expect(unit).toContain("Environment=AXIOM_DISCORD_BOT_TOKEN=DISCORD_TOKEN");
		expect(written.get("/home/mustbearn/.config/axiom-gateway.env")).toContain(
			"AXIOM_DISCORD_BOT_TOKEN=DISCORD_TOKEN",
		);
	});

	test("rejects empty tokens and non-token connectors", async () => {
		const { deps } = makeDeps();
		await expect(setConnectorToken(connectorById("telegram")!, "  \n", deps)).rejects.toThrow();
		await expect(setConnectorToken(connectorById("signal")!, "x", deps)).rejects.toThrow();
	});
});

describe("switchGatewayTransport", () => {
	test("rewrites the unit, daemon-reloads, and restarts the service", async () => {
		const { deps, execCalls } = makeDeps({ env: { AXIOM_DISCORD_BOT_TOKEN: "tok" } });
		const lines = await switchGatewayTransport(connectorById("discord")!, deps);
		expect(lines.join("\n")).toContain("discord");
		expect(execCalls.map((c) => `${c.command} ${c.args.join(" ")}`)).toEqual([
			"systemctl --user show axiom-telegram-gateway.service -p ActiveState -p FragmentPath",
			"systemctl --user daemon-reload",
			"systemctl --user restart axiom-telegram-gateway.service",
		]);
	});

	test("refuses to switch to a token connector with no token anywhere", async () => {
		const { deps, execCalls } = makeDeps();
		const lines = await switchGatewayTransport(connectorById("slack")!, deps);
		expect(lines.join("\n")).toContain("AXIOM_SLACK_BOT_TOKEN");
		expect(execCalls.filter((c) => c.args.includes("restart"))).toEqual([]);
	});

	test("no-ops when the gateway already runs under the connector", async () => {
		const { deps, execCalls } = makeDeps();
		const lines = await switchGatewayTransport(connectorById("telegram")!, deps);
		expect(lines.join("\n")).toContain("already");
		expect(execCalls.filter((c) => c.args.includes("restart"))).toEqual([]);
	});

	test("refuses to restart when this process lives in the service cgroup", async () => {
		const { deps } = makeDeps({
			cgroupText: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/axiom-telegram-gateway.service\n",
			env: { AXIOM_DISCORD_BOT_TOKEN: "tok" },
		});
		const lines = await switchGatewayTransport(connectorById("discord")!, deps);
		expect(lines.join("\n")).toContain("standalone terminal");
	});

	test("errors when the service unit cannot be found", async () => {
		const { deps } = makeDeps({
			execResults: new Map([
				[
					"systemctl --user show axiom-telegram-gateway.service -p ActiveState -p FragmentPath",
					{ code: 1, stdout: "", stderr: "no unit" },
				],
			]),
			env: { AXIOM_DISCORD_BOT_TOKEN: "tok" },
		});
		const lines = await switchGatewayTransport(connectorById("discord")!, deps);
		expect(lines.join("\n")).toContain("no gateway systemd unit");
	});

	test("warns when switching to signal without signal-cli on PATH", async () => {
		const { deps } = makeDeps({
			execResults: new Map([["which signal-cli", { code: 1, stdout: "", stderr: "not found" }]]),
		});
		const lines = await switchGatewayTransport(connectorById("signal")!, deps);
		expect(lines.join("\n")).toContain("signal-cli");
	});
});

describe("isProcessInServiceCgroup", () => {
	test("matches the service name anywhere in a cgroup line", () => {
		const deps = makeDeps({
			cgroupText: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/axiom-telegram-gateway.service\n",
		}).deps;
		expect(isProcessInServiceCgroup(deps)).toBe(true);
	});

	test("is false for unrelated cgroups and unreadable files", () => {
		const deps = makeDeps({
			cgroupText: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/kitty-123.scope\n",
		}).deps;
		expect(isProcessInServiceCgroup(deps)).toBe(false);
		const missing = {
			...deps,
			readFile: () => {
				throw new Error("ENOENT");
			},
		};
		expect(isProcessInServiceCgroup(missing)).toBe(false);
	});
});

describe("runConnectorsCommandArgs", () => {
	test("returns undefined for an empty invocation (the menu opens)", async () => {
		const { deps } = makeDeps();
		expect(await runConnectorsCommandArgs("", deps)).toBeUndefined();
	});

	test("status prints the service state and each connector", async () => {
		const { deps } = makeDeps({ env: { AXIOM_SLACK_BOT_TOKEN: "x" } });
		const lines = await runConnectorsCommandArgs("status", deps);
		expect(lines).toBeDefined();
		expect(lines![0]).toContain("axiom-telegram-gateway.service");
		expect(lines!.join("\n")).toContain("slack — token set");
	});

	test("help <name> prints the connector guide and unknown names error", async () => {
		const { deps } = makeDeps();
		const lines = await runConnectorsCommandArgs("help discord", deps);
		expect(lines!.join("\n")).toContain("AXIOM_DISCORD_BOT_TOKEN");
		const unknown = await runConnectorsCommandArgs("help nope", deps);
		expect(unknown!.join("\n")).toContain("unknown connector");
	});

	test("bare help and unknown args print usage", async () => {
		const { deps } = makeDeps();
		for (const args of ["help", "bogus"]) {
			const lines = await runConnectorsCommandArgs(args, deps);
			expect(lines!.join("\n")).toContain("usage");
		}
	});
});

// Type-only guard: the state shape is fully exported for the TUI menu.
const _stateCheck: GatewayServiceState = {
	serviceName: "axiom-telegram-gateway.service",
	activeState: "active",
	fragmentPath: "/x.service",
	transport: "telegram",
	unitTokenVars: ["AXIOM_TELEGRAM_BOT_TOKEN"],
};
void _stateCheck;
void readFileSync;
void vi;
