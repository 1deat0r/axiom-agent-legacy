/**
 * The helper-process bridge for the `delegate` tool.
 *
 * A `delegate` call is exactly one fresh helper process: start -> runTask ->
 * stop. The helper is a headless agent spawned over the existing RPC bridge
 * (`--mode rpc`, via `RpcClient`), so its intermediate tool calls and full
 * context live inside the helper process and never enter the parent session.
 *
 * The bridge is a narrow, injected interface so neutral tests can drive the
 * tool with a deterministic stub (no process, no keys) while the real
 * `createRpcClientBridge` wires the genuine helper process.
 */

import type { SessionStats } from "../../core/session-stats.js";
import { RpcClient } from "../../modes/rpc/rpc-client.js";

/** What a single delegatation run harvests from the helper. */
export interface RpcDelegateRunResult {
	/** The helper's final assistant text (closing summary), if any. */
	lastAssistantText: string | null;
	/** Recorded session stats (token accounting + cost). */
	stats: SessionStats;
}

/** Narrow interface the tool depends on; implemented by the RPC bridge adapter. */
export interface RpcDelegateBridge {
	start(): Promise<void>;
	runTask(task: string, timeoutMs: number): Promise<RpcDelegateRunResult>;
	stop(): Promise<void>;
}

export interface RpcClientBridgeOptions {
	cliPath?: string;
	cwd?: string;
	env?: Record<string, string>;
	provider?: string;
	model?: string;
}

/**
 * Parse a "provider/model" (or bare "model") reference into client options.
 * The tool's `model` param uses this so the helper is actually configured with
 * the requested model — never merely echoed back unhonored.
 */
export function parseModelRef(ref: string | undefined): { provider?: string; model?: string } {
	if (typeof ref !== "string") {
		return {};
	}
	const trimmed = ref.trim();
	if (!trimmed) {
		return {};
	}
	const slash = trimmed.indexOf("/");
	if (slash > 0 && slash < trimmed.length - 1) {
		return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
	}
	return { model: trimmed };
}

/**
 * Build one helper process backed by `RpcClient` (`--mode rpc`).
 * One instance = one running helper process; the tool constructs, starts,
 * runs, and stops it for each delegate call (per-call reset, never reused).
 */
export function createRpcClientBridge(options: RpcClientBridgeOptions = {}): RpcDelegateBridge {
	let client: RpcClient | null = new RpcClient({
		...(options.cliPath ? { cliPath: options.cliPath } : {}),
		...(options.cwd ? { cwd: options.cwd } : {}),
		...(options.env ? { env: options.env } : {}),
		...(options.provider ? { provider: options.provider } : {}),
		...(options.model ? { model: options.model } : {}),
	});

	return {
		async start(): Promise<void> {
			if (!client) {
				throw new Error("delegate helper already stopped");
			}
			await client.start();
		},
		async runTask(task: string, timeoutMs: number): Promise<RpcDelegateRunResult> {
			const current = client;
			if (!current) {
				throw new Error("delegate helper not started");
			}
			// One fresh process per delegate call already implies a fresh session.
			await current.promptAndWait(task, undefined, timeoutMs);
			const lastAssistantText = await current.getLastAssistantText();
			const stats = await current.getSessionStats();
			return { lastAssistantText, stats };
		},
		async stop(): Promise<void> {
			const current = client;
			client = null;
			if (current) {
				await current.stop();
			}
		},
	};
}
