/**
 * Gateway configuration under the profile home: `<AXIOM_HOME>/gateway/config.json`
 * holds the sender allowlist. Non-listed senders are denied before the model.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayConfig } from "./types.js";

export const GATEWAY_CONFIG_FILE = "config.json";

export function defaultGatewayConfig(): GatewayConfig {
	return { senders: [] };
}

export function gatewayConfigPath(axiomHomeDir: string): string {
	return join(axiomHomeDir, "gateway", GATEWAY_CONFIG_FILE);
}

/** Load the allowlist; a missing/malformed file yields an empty allowlist. */
export function loadGatewayConfig(axiomHomeDir: string): GatewayConfig {
	try {
		const raw = JSON.parse(readFileSync(gatewayConfigPath(axiomHomeDir), "utf8")) as Partial<GatewayConfig>;
		if (Array.isArray(raw.senders)) return { senders: raw.senders.filter((s): s is string => typeof s === "string") };
		return defaultGatewayConfig();
	} catch {
		return defaultGatewayConfig();
	}
}

/** True when the sender is allowlisted (the only audience that reaches the agent). */
export function isAllowedSender(config: GatewayConfig, sender: string): boolean {
	return config.senders.includes(sender);
}
