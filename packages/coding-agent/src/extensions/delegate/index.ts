/**
 * The axiom `delegate` tool (feature #5, first step — RPC bridge that spawns a
 * helper process and returns only a compact result block into the parent
 * session; the Hermes delegate_tool.py analog).
 *
 * Calling `delegate` spawns an isolated helper process (via `--mode rpc`),
 * runs one bounded task inside it, and returns ONLY a compact result block —
 * `{ok, summary, tokens, cost, helper?, error?}`. The helper's intermediate
 * tool calls and full context never enter the parent session: a multi-step
 * pipeline collapses into one zero-context-cost turn, and the ledger ethos is
 * honored because the block reports only RECORDED tokens/cost (never guessed).
 *
 * Dependencies are injectable for tests; the default `bridge` factory wires
 * the real helper process via `createRpcClientBridge`.
 */

import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.js";
import { createRpcClientBridge, parseModelRef, type RpcDelegateBridge } from "./bridge.js";
import { DEFAULT_SUMMARY_MAX_CHARS, emptyAccounting, renderDelegateResult, toDelegateResult } from "./result.js";
import type { DelegateResult } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 300_000;

const DelegateParamsSchema = Type.Object({
	task: Type.String(),
	name: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Number()),
});

type DelegateParams = Static<typeof DelegateParamsSchema>;

export interface DelegateDeps {
	/** Factory for one helper process per delegate call. A model reference
	 *  ("provider/model") may be supplied to configure the helper. */
	bridge(model?: string): RpcDelegateBridge;
	/** Default per-run budget in ms (clamped to MAX_TIMEOUT_MS). */
	timeoutMs: number;
	/** Summary cap for the compact block. */
	summaryMaxChars: number;
}

const DEFAULT_DEPS: Pick<DelegateDeps, "timeoutMs" | "summaryMaxChars"> = {
	timeoutMs: DEFAULT_TIMEOUT_MS,
	summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS,
};

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: Error): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(onTimeout), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export function createDelegateExtension(deps?: Partial<DelegateDeps>): (pi: ExtensionAPI) => void {
	const resolved: DelegateDeps = {
		bridge: deps?.bridge ?? ((model?: string) => createRpcClientBridge(parseModelRef(model))),
		timeoutMs: deps?.timeoutMs ?? DEFAULT_DEPS.timeoutMs,
		summaryMaxChars: deps?.summaryMaxChars ?? DEFAULT_DEPS.summaryMaxChars,
	};

	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "delegate",
			label: "Delegate",
			description:
				"Run a task in an isolated helper process and return only a compact result block. " +
				"Use for self-contained multi-step work you do not want in your own context: the helper " +
				"carries out the task (its intermediate tool calls stay out of this session), and you " +
				"receive a short summary plus honest token/cost accounting. " +
				"Parameters: task (required instruction), optional name, model, timeoutMs.",
			parameters: DelegateParamsSchema,
			execute: async (_toolCallId, params: DelegateParams) => {
				const task = (params.task ?? "").trim();
				if (!task) {
					throw new Error("delegate requires a non-empty task");
				}
				const requested =
					typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
						? params.timeoutMs
						: resolved.timeoutMs;
				const timeoutMs = Math.max(1, Math.min(requested, MAX_TIMEOUT_MS));

				// One fresh helper process per call (per-call reset), configured with
				// the requested model when supplied.
				const bridge = resolved.bridge(params.model);
				let result: DelegateResult;
				try {
					await bridge.start();
					const timeoutError = new Error(`delegate timed out after ${timeoutMs}ms`);
					const run = await withTimeout(bridge.runTask(task, timeoutMs), timeoutMs, timeoutError);
					result = toDelegateResult(
						{
							ok: true,
							summary: run.lastAssistantText,
							tokens: run.stats.tokens ?? emptyAccounting(),
							cost: run.stats.cost,
							helper: { name: params.name, model: params.model },
						},
						resolved.summaryMaxChars,
					);
				} catch (error) {
					result = toDelegateResult(
						{
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						},
						resolved.summaryMaxChars,
					);
				} finally {
					// Always reap the helper — no orphan processes on error/timeout.
					await bridge.stop().catch(() => undefined);
				}

				return {
					content: [{ type: "text", text: renderDelegateResult(result) }],
					details: result,
				};
			},
		});
	};
}

export default function axiomDelegateExtension(pi: ExtensionAPI): void {
	createDelegateExtension()(pi);
}
