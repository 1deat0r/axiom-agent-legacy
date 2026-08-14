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
 * Environment variables the delegate helper must never inherit from the
 * parent agent process.
 *
 * RLM_* flip the rlm max-depth default to "env" and point the helper at the
 * harness session state; AXIOM_CODING_AGENT_DIR points the helper agent dir
 * at the harness session dir. A helper that inherits them emits no RPC
 * events and hangs until the collect timeout (issue #26). The RLM_* subset
 * matches the set ./test.sh unsets; delegate.test.ts keeps them in sync.
 */
export const HELPER_ENV_SCRUB_KEYS = [
	"RLM_DEPTH",
	"RLM_MAX_DEPTH",
	"RLM_SESSION_DIR",
	"RLM_GLOBAL_HARNESS_STATE_DIR",
	"RLM_HARNESS_STATE_DIR",
	"AXIOM_CODING_AGENT_DIR",
] as const;

/**
 * Build the helper env: the ambient env with every harness variable marked
 * unset (undefined), then any explicit extra entries merged last so callers
 * can still override deliberately.
 *
 * The bridge passes the whole map as `RpcClientOptions.env`; RpcClient drops
 * undefined entries at spawn, so scrubbed variables never reach the helper.
 */
export function scrubHelperEnv(
	env: Record<string, string | undefined>,
	extra: Record<string, string> = {},
): Record<string, string | undefined> {
	const scrubbed: Record<string, string | undefined> = { ...env };
	for (const key of HELPER_ENV_SCRUB_KEYS) {
		scrubbed[key] = undefined;
	}
	return { ...scrubbed, ...extra };
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
		// Always pass the scrubbed ambient env (never let the merge fall back
		// to a wholesale process.env that carries harness variables).
		env: scrubHelperEnv(process.env, options.env),
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
