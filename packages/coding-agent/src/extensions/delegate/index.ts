/**
 * The axiom `delegate` tool (feature #5 — RPC bridge that spawns helper
 * processes and returns only compact result blocks into the parent session;
 * the Hermes delegate_tool.py analog).
 *
 * Calling `delegate` spawns isolated helper processes (via `--mode rpc`), runs
 * a single bounded task (or a batch in parallel), and returns ONLY compact
 * result blocks — single: `{ok, summary, tokens, cost, helper?, error?}`;
 * batch (`tasks[]`): an aggregate `{ok, delegations[], tokens, cost}`. The
 * helpers' intermediate tool calls and full context never enter the parent
 * session: a multi-step pipeline collapses into one zero-context-cost turn,
 * and the ledger ethos is honored because blocks report only RECORDED
 * tokens/cost (never guessed).
 *
 * Dependencies are injectable for tests; the default `bridge` factory wires
 * the real helper process via `createRpcClientBridge`.
 */

import { join } from "node:path";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.js";
import type { ExtensionAPI } from "../../core/extensions/types.js";
import {
	type BackgroundDelegateEntry,
	BackgroundDelegateRegistry,
	renderBackgroundBatchStarted,
	renderBackgroundPending,
	renderBackgroundStarted,
	withTimeout,
} from "./background.js";
import { createRpcClientBridge, parseModelRef, type RpcDelegateBridge } from "./bridge.js";
import {
	DEFAULT_SUMMARY_MAX_CHARS,
	emptyAccounting,
	renderBatchResult,
	renderDelegateResult,
	toBatchResult,
	toDelegateResult,
} from "./result.js";
import type { DelegateBatchResult, DelegateResult } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 300_000;
/** Upper bound on the number of tasks in one batch (guard against unbounded fan-out). */
export const MAX_TASKS = 16;
/** Cap on concurrently-running helpers in a batch (bounded concurrency pool). */
export const BATCH_CONCURRENCY = 4;

const DelegateParamsSchema = Type.Object({
	task: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(Type.String())),
	name: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Number()),
	/** Non-blocking mode: return immediately with a handle; collect later. */
	background: Type.Optional(Type.Boolean()),
	/** Collect a background run (status, or the result block once settled). */
	handle: Type.Optional(Type.String()),
	/** Optional wait budget (ms) when collecting a running background run. */
	waitMs: Type.Optional(Type.Number()),
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
	/** Directory for background result files (default: <agentDir>/delegate-results). */
	resultsDir: string;
	/** Registry for background runs (injected for tests; defaults to a fresh one). */
	registry?: BackgroundDelegateRegistry;
}

const DEFAULT_DEPS: Pick<DelegateDeps, "timeoutMs" | "summaryMaxChars"> = {
	timeoutMs: DEFAULT_TIMEOUT_MS,
	summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS,
};

/**
 * Map `fn` over `items` with at most `limit` concurrent executions, preserving
 * input order in the result. Bounds the number of spawned helpers in a batch.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) {
				return;
			}
			results[index] = await fn(items[index]);
		}
	}
	const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

/**
 * Run one delegation to completion on a fresh helper bridge, returning a
 * compact block. Always start + stop the bridge (no orphan on error/timeout).
 */
async function runDelegation(
	bridge: RpcDelegateBridge,
	task: string,
	timeoutMs: number,
	name: string | undefined,
	model: string | undefined,
	summaryMaxChars: number,
): Promise<DelegateResult> {
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
				helper: { name, model, sessionId: run.stats.sessionId },
			},
			summaryMaxChars,
		);
	} catch (error) {
		result = toDelegateResult(
			{ ok: false, error: error instanceof Error ? error.message : String(error) },
			summaryMaxChars,
		);
	} finally {
		// Always reap the helper — no orphan processes on error/timeout.
		await bridge.stop().catch(() => undefined);
	}
	return result;
}

export function createDelegateExtension(deps?: Partial<DelegateDeps>): (pi: ExtensionAPI) => void {
	const resolved: DelegateDeps = {
		bridge: deps?.bridge ?? ((model?: string) => createRpcClientBridge(parseModelRef(model))),
		timeoutMs: deps?.timeoutMs ?? DEFAULT_DEPS.timeoutMs,
		summaryMaxChars: deps?.summaryMaxChars ?? DEFAULT_DEPS.summaryMaxChars,
		resultsDir: deps?.resultsDir ?? join(getAgentDir(), "delegate-results"),
	};
	const registry = deps?.registry ?? new BackgroundDelegateRegistry(resolved.resultsDir);

	return (pi: ExtensionAPI) => {
		// Reap background helpers when the session is torn down.
		pi.on("session_shutdown", () => {
			void registry.shutdown();
		});
		pi.registerTool({
			name: "delegate",
			label: "Delegate",
			description:
				"Run a task in an isolated helper process and return only a compact result block. " +
				"Use for self-contained multi-step work you do not want in your own context: the helper " +
				"carries out the task (its intermediate tool calls stay out of this session), and you " +
				"receive a short summary plus honest token/cost accounting. To fan out independent work " +
				"in parallel, pass tasks (a list) and receive one compact block per task. " +
				"Parameters: task OR tasks (required), optional name, model, timeoutMs. " +
				"Non-blocking mode: pass background=true to return immediately with a handle; the helper " +
				"keeps working while you continue, and its compact result lands in a result file. " +
				"Collect later with handle plus optional waitMs (waitMs blocks up to that budget).",
			parameters: DelegateParamsSchema,
			execute: async (_toolCallId, params: DelegateParams, _signal, _onUpdate, ctx) => {
				// Collect path: no task required.
				if (params.handle) {
					const waitMs =
						typeof params.waitMs === "number" && Number.isFinite(params.waitMs)
							? Math.max(0, Math.min(params.waitMs, MAX_TIMEOUT_MS))
							: undefined;
					const entry: BackgroundDelegateEntry | undefined = await registry.collect(params.handle.trim(), waitMs);
					if (!entry) {
						throw new Error(`unknown delegate handle: ${params.handle}`);
					}
					if (entry.status === "running") {
						return {
							content: [{ type: "text", text: renderBackgroundPending(entry) }],
							details: {
								background: true,
								handle: entry.handle,
								status: entry.status,
								resultFile: entry.resultFile,
							},
						};
					}
					const collected = entry.result!;
					return {
						content: [{ type: "text", text: renderDelegateResult(collected) }],
						details: collected,
					};
				}

				const singleTask = (params.task ?? "").trim();
				const batchTasks = (params.tasks ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
				if (singleTask.length === 0 && batchTasks.length === 0) {
					throw new Error("delegate requires a non-empty task or a non-empty tasks list");
				}
				const requested =
					typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
						? params.timeoutMs
						: resolved.timeoutMs;
				const timeoutMs = Math.max(1, Math.min(requested, MAX_TIMEOUT_MS));

				// Resolve the helper model: an explicit `model` param wins; otherwise
				// default to the parent's LIVE model (ctx.model) so the helper follows
				// the session instead of drifting to the tool default.
				const viaParam = params.model?.trim() || undefined;
				const viaParent = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const effectiveModel = viaParam ?? viaParent;

				if (params.background === true) {
					const startInput = {
						bridge: resolved.bridge(effectiveModel),
						task: singleTask,
						timeoutMs,
						name: params.name,
						model: effectiveModel,
						summaryMaxChars: resolved.summaryMaxChars,
					};
					if (batchTasks.length > 0) {
						if (batchTasks.length > MAX_TASKS) {
							throw new Error(`delegate batch exceeds MAX_TASKS (${MAX_TASKS}) — got ${batchTasks.length}`);
						}
						const entries = batchTasks.map((task) =>
							registry.start({ ...startInput, bridge: resolved.bridge(effectiveModel), task }),
						);
						return {
							content: [{ type: "text", text: renderBackgroundBatchStarted(entries) }],
							details: {
								background: true,
								handles: entries.map((entry) => entry.handle),
								resultFiles: entries.map((entry) => entry.resultFile),
							},
						};
					}
					const entry = registry.start(startInput);
					return {
						content: [{ type: "text", text: renderBackgroundStarted(entry) }],
						details: {
							background: true,
							handle: entry.handle,
							status: entry.status,
							resultFile: entry.resultFile,
							helper: { name: entry.name, model: entry.model },
						},
					};
				}

				if (batchTasks.length > 0) {
					if (batchTasks.length > MAX_TASKS) {
						throw new Error(`delegate batch exceeds MAX_TASKS (${MAX_TASKS}) — got ${batchTasks.length}`);
					}
					// Bounded parallel fan-out: one fresh helper per task through a
					// fixed concurrency pool (BATCH_CONCURRENCY). Each delegation reaps
					// its own bridge; a failing task does not abort its siblings
					// (partial failure -> ok:false but results kept).
					const delegations = await mapWithConcurrency(batchTasks, BATCH_CONCURRENCY, (task) =>
						runDelegation(
							resolved.bridge(effectiveModel),
							task,
							timeoutMs,
							params.name,
							effectiveModel,
							resolved.summaryMaxChars,
						),
					);
					const batch: DelegateBatchResult = toBatchResult(delegations);
					return {
						content: [{ type: "text", text: renderBatchResult(batch) }],
						details: batch,
					};
				}

				const result = await runDelegation(
					resolved.bridge(effectiveModel),
					singleTask,
					timeoutMs,
					params.name,
					effectiveModel,
					resolved.summaryMaxChars,
				);
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
