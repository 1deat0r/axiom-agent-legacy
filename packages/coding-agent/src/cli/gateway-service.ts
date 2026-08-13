/**
 * Gateway service controller (ADR-0036): the terminal-side operations behind
 * `/connectors` — read the gateway systemd unit's state, set connector
 * credentials, and switch the transport the unit boots under. Every operation
 * takes an injected `GatewayServiceDeps` so the TUI handler and the tests
 * drive the same pure logic against fakes (systemctl, unit/env files, cgroup).
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	connectorById,
	connectorGuideLines,
	GATEWAY_CONNECTORS,
	type GatewayConnector,
	type GatewayConnectorId,
	isGatewayConnectorId,
} from "../gateway/connectors.js";

export interface GatewayServiceDeps {
	/** The systemd user unit that runs the gateway (override via AXIOM_GATEWAY_SERVICE). */
	serviceName: string;
	/** The gateway env file carrying bot tokens (EnvironmentFile-style backup). */
	envFilePath: string;
	/** Run an external command (systemctl, which); resolves with code + output. */
	exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
	readFile(path: string): string;
	writeFile(path: string, content: string): void;
	/** Process environment, consulted as a token fallback. */
	env: Record<string, string | undefined>;
	/** /proc/self/cgroup path for the "am I inside the service?" guard. */
	cgroupPath: string;
}

export function defaultGatewayServiceDeps(): GatewayServiceDeps {
	return {
		serviceName: process.env.AXIOM_GATEWAY_SERVICE ?? "axiom-telegram-gateway.service",
		envFilePath: join(homedir(), ".config", "axiom-gateway.env"),
		exec: (command, args) =>
			new Promise((resolve) => {
				execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
					if (error) {
						const code =
							typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
						resolve({ code, stdout: String(stdout), stderr: String(stderr) });
					} else {
						resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
					}
				});
			}),
		readFile: (path) => readFileSync(path, "utf8"),
		writeFile: (path, content) => writeFileSync(path, content, "utf8"),
		env: process.env,
		cgroupPath: "/proc/self/cgroup",
	};
}

/** The gateway unit's resolved state (empty fields when the unit is absent/unreadable). */
export interface GatewayServiceState {
	serviceName: string;
	/** systemd ActiveState ("active", "inactive", "failed", ...); undefined without a unit. */
	activeState?: string;
	/** The unit's on-disk fragment path (from systemctl show); undefined without a unit. */
	fragmentPath?: string;
	/** The transport the unit boots under (--transport); undefined when unset/absent. */
	transport?: GatewayConnectorId;
	/** Bot-token env vars present as Environment= lines in the unit. */
	unitTokenVars: string[];
}

/** Per-connector status for the /connectors menu and status lines. */
export interface ConnectorStatus {
	connector: GatewayConnector;
	/** The gateway service runs and is booted under this connector. */
	active: boolean;
	/** The gateway service is running (any transport). */
	serviceRunning: boolean;
	credentialConfigured: boolean;
	/** Short menu label: "active", "token set", "no token", "signal-cli found", "signal-cli missing". */
	label: string;
}

const EMPTY_STATE = (serviceName: string): GatewayServiceState => ({
	serviceName,
	activeState: undefined,
	fragmentPath: undefined,
	transport: undefined,
	unitTokenVars: [],
});

/** The transport flag on the ExecStart line (`--transport x` or `--transport=x`). */
export function parseUnitTransport(unitText: string): string | undefined {
	for (const line of unitText.split("\n")) {
		if (!line.startsWith("ExecStart=")) continue;
		const match = /--transport(?:=|\s+)(\S+)/.exec(line);
		if (match) return match[1];
		return undefined;
	}
	return undefined;
}

/** Bot-token env var NAMES on Environment= lines (AXIOM_*_BOT_TOKEN only). */
export function parseUnitTokenVars(unitText: string): string[] {
	const vars: string[] = [];
	for (const line of unitText.split("\n")) {
		if (!line.startsWith("Environment=")) continue;
		const match = /^Environment=([A-Z0-9_]+)=/.exec(line);
		if (match && match[1].endsWith("_BOT_TOKEN")) vars.push(match[1]);
	}
	return vars;
}

/** Rewrite the ExecStart transport flag (append it when the unit has none). */
export function rewriteUnitTransport(unitText: string, transport: GatewayConnectorId): string {
	const lines = unitText.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.startsWith("ExecStart=")) continue;
		if (/--transport(?:=|\s+)\S+/.test(line)) {
			lines[i] = line.replace(/--transport(?:=|\s+)\S+/, `--transport ${transport}`);
		} else {
			lines[i] = `${line.trimEnd()} --transport ${transport}`;
		}
		break;
	}
	return lines.join("\n");
}

/** Add/update one Environment=NAME=value line in the unit (after the last Environment line). */
export function setUnitEnvLine(unitText: string, name: string, value: string): string {
	const lines = unitText.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.startsWith(`Environment=${name}=`)) {
			lines[i] = `Environment=${name}=${value}`;
			return lines.join("\n");
		}
	}
	let insertAt = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.startsWith("Environment=")) insertAt = i;
	}
	if (insertAt === -1) {
		for (let i = 0; i < lines.length; i++) {
			if (lines[i]!.startsWith("ExecStart=")) insertAt = i;
		}
	}
	const entry = `Environment=${name}=${value}`;
	if (insertAt === -1) {
		lines.push(entry);
	} else {
		lines.splice(insertAt + 1, 0, entry);
	}
	return lines.join("\n");
}

/** Replace an existing KEY= line in the env file, else append KEY=value. */
export function setEnvFileLine(envFileText: string, name: string, value: string): string {
	const lines = envFileText.length === 0 ? [] : envFileText.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.startsWith(`${name}=`)) {
			lines[i] = `${name}=${value}`;
			return lines.join("\n");
		}
	}
	lines.push(`${name}=${value}`);
	return lines.join("\n");
}

/** Read the gateway unit's state via systemctl; empty state when the unit is absent. */
export async function readGatewayServiceState(deps: GatewayServiceDeps): Promise<GatewayServiceState> {
	const result = await deps.exec("systemctl", [
		"--user",
		"show",
		deps.serviceName,
		"-p",
		"ActiveState",
		"-p",
		"FragmentPath",
	]);
	if (result.code !== 0) return EMPTY_STATE(deps.serviceName);
	let activeState: string | undefined;
	let fragmentPath: string | undefined;
	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("ActiveState=")) activeState = line.slice("ActiveState=".length).trim() || undefined;
		if (line.startsWith("FragmentPath=")) fragmentPath = line.slice("FragmentPath=".length).trim() || undefined;
	}
	if (!fragmentPath) return { ...EMPTY_STATE(deps.serviceName), activeState };
	let transport: GatewayConnectorId | undefined;
	let unitTokenVars: string[] = [];
	try {
		const unitText = deps.readFile(fragmentPath);
		const parsed = parseUnitTransport(unitText);
		transport = parsed !== undefined && isGatewayConnectorId(parsed) ? parsed : undefined;
		unitTokenVars = parseUnitTokenVars(unitText);
	} catch {
		// Unit vanished or is unreadable: report what systemctl said, nothing else.
	}
	return { serviceName: deps.serviceName, activeState, fragmentPath, transport, unitTokenVars };
}

function envFileHasVar(deps: GatewayServiceDeps, name: string): boolean {
	try {
		return deps
			.readFile(deps.envFilePath)
			.split("\n")
			.some((line) => line.startsWith(`${name}=`));
	} catch {
		return false;
	}
}

function credentialConfigured(
	deps: GatewayServiceDeps,
	state: GatewayServiceState,
	connector: GatewayConnector,
	signalCliFound: boolean,
): boolean {
	if (connector.kind === "signal-cli") return signalCliFound;
	const envVar = connector.tokenEnvVar ?? "";
	return Boolean(deps.env[envVar]) || state.unitTokenVars.includes(envVar) || envFileHasVar(deps, envVar);
}

/** Per-connector status for the menu and the /connectors status surface. */
export async function readGatewayConnectorStatus(
	deps: GatewayServiceDeps,
	state: GatewayServiceState,
): Promise<ConnectorStatus[]> {
	const which = await deps.exec("which", ["signal-cli"]);
	const signalCliFound = which.code === 0;
	const serviceRunning = state.activeState === "active";
	const out: ConnectorStatus[] = [];
	for (const connector of GATEWAY_CONNECTORS) {
		const active = serviceRunning && state.transport === connector.id;
		const configured = credentialConfigured(deps, state, connector, signalCliFound);
		const label = active
			? "active"
			: connector.kind === "signal-cli"
				? signalCliFound
					? "signal-cli found"
					: "signal-cli missing"
				: configured
					? "token set"
					: "no token";
		out.push({ connector, active, serviceRunning, credentialConfigured: configured, label });
	}
	return out;
}

/** Status lines for /connectors status: service state first, then each connector. */
export function formatConnectorStatusLines(state: GatewayServiceState, statuses: ConnectorStatus[]): string[] {
	const head = `gateway service: ${state.serviceName} — ${state.activeState ?? "unit not found"}${
		state.transport ? ` (running as ${state.transport})` : ""
	}`;
	return [head, ...statuses.map((status) => `${status.connector.id} — ${status.label}`)];
}

/** Whether this process lives inside the gateway service's cgroup (a restart would kill us). */
export function isProcessInServiceCgroup(deps: GatewayServiceDeps): boolean {
	try {
		return deps
			.readFile(deps.cgroupPath)
			.split("\n")
			.some((line) => line.includes(deps.serviceName));
	} catch {
		return false;
	}
}

/**
 * Store a bot token for a token connector: update the unit's Environment line
 * and the gateway env file. Never echoes the token back.
 */
export async function setConnectorToken(
	connector: GatewayConnector,
	token: string,
	deps: GatewayServiceDeps,
): Promise<string[]> {
	if (connector.kind !== "token" || !connector.tokenEnvVar) {
		throw new Error(`connector '${connector.id}' does not take a bot token`);
	}
	const trimmed = token.trim();
	if (trimmed.length === 0 || /[\r\n]/.test(token)) {
		throw new Error(`refusing to store an empty or multi-line token for ${connector.id}`);
	}
	const envVar = connector.tokenEnvVar;
	const state = await readGatewayServiceState(deps);
	const touched: string[] = [];
	if (state.fragmentPath) {
		const unitText = deps.readFile(state.fragmentPath);
		deps.writeFile(state.fragmentPath, setUnitEnvLine(unitText, envVar, trimmed));
		touched.push(state.fragmentPath);
	}
	const envFileText = envFileHasVar(deps, envVar) ? deps.readFile(deps.envFilePath) : "";
	deps.writeFile(deps.envFilePath, setEnvFileLine(envFileText, envVar, trimmed));
	touched.push(deps.envFilePath);
	const note = state.fragmentPath
		? "restart the gateway (Use now) for it to take effect"
		: `no gateway unit found for ${deps.serviceName} — the env file will apply when a gateway is started`;
	return [`set ${envVar} in ${touched.join(" and ")} — ${note}`];
}

/**
 * Switch the gateway unit to boot under `connector`: rewrite the ExecStart
 * transport flag, daemon-reload, restart. Refuses when the token is missing,
 * when already on that transport, or when this process is inside the service.
 */
export async function switchGatewayTransport(connector: GatewayConnector, deps: GatewayServiceDeps): Promise<string[]> {
	const state = await readGatewayServiceState(deps);
	if (!state.fragmentPath) {
		return [
			`cannot switch: no gateway systemd unit found for ${deps.serviceName} — set AXIOM_GATEWAY_SERVICE or start the gateway manually`,
		];
	}
	if (state.transport === connector.id) {
		return [`gateway already runs under ${connector.id} — no change`];
	}
	if (connector.kind === "token") {
		if (!credentialConfigured(deps, state, connector, false)) {
			return [
				`cannot switch to ${connector.id}: no ${connector.tokenEnvVar} token found — set it first (choose ${connector.label} in /connectors, then Set token)`,
			];
		}
	}
	if (isProcessInServiceCgroup(deps)) {
		return [
			`cannot switch: this process runs inside ${deps.serviceName} — run /connectors from a standalone terminal so the restart does not kill the session`,
		];
	}
	const warnings: string[] = [];
	if (connector.kind === "signal-cli") {
		const which = await deps.exec("which", ["signal-cli"]);
		if (which.code !== 0) {
			warnings.push(
				`warning: signal-cli not found on PATH — install and link it (signal-cli link) or the gateway cannot send or receive`,
			);
		}
	}
	const unitText = deps.readFile(state.fragmentPath);
	deps.writeFile(state.fragmentPath, rewriteUnitTransport(unitText, connector.id));
	const reload = await deps.exec("systemctl", ["--user", "daemon-reload"]);
	const restart = await deps.exec("systemctl", ["--user", "restart", deps.serviceName]);
	const lines = [`switched the gateway to ${connector.id} and restarted ${deps.serviceName}`, ...warnings];
	if (reload.code !== 0) lines.push(`daemon-reload failed: ${reload.stderr.trim()}`);
	if (restart.code !== 0) lines.push(`restart failed: ${restart.stderr.trim()}`);
	return lines;
}

/**
 * Handle the /connectors argument forms; returns the lines to print, or
 * undefined when the invocation opens the interactive menu (no args).
 */
export async function runConnectorsCommandArgs(args: string, deps: GatewayServiceDeps): Promise<string[] | undefined> {
	const trimmed = args.trim();
	if (trimmed.length === 0) return undefined;
	if (trimmed === "status") {
		const state = await readGatewayServiceState(deps);
		const statuses = await readGatewayConnectorStatus(deps, state);
		return formatConnectorStatusLines(state, statuses);
	}
	const helpMatch = /^help(?:\s+(\S+))?$/.exec(trimmed);
	if (helpMatch) {
		const id = helpMatch[1];
		if (!id) return usageLines();
		const connector = connectorById(id);
		if (!connector) return [`unknown connector '${id}' — signal, telegram, discord, or slack`];
		return connectorGuideLines(connector);
	}
	return usageLines();
}

function usageLines(): string[] {
	return ["usage: /connectors [status|help <signal|telegram|discord|slack>]", "no argument opens the connector menu"];
}
