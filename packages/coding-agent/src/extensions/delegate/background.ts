/**
 * Background (non-blocking) delegation for the `delegate` tool.
 *
 * A background run detaches the helper from the tool call: the tool returns
 * immediately with a handle and a deterministic result-file path, the helper
 * keeps running in its own process, and its compact result block is written
 * to the result file (and kept in the registry) when it settles. The model
 * collects later with `delegate(handle=...)` or by reading the file.
 *
 * The registry owns helper lifecycle for background runs: every path —
 * success, error, timeout — stops the bridge exactly once, and
 * session_shutdown reaps whatever is still running.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcDelegateBridge } from "./bridge.js";
import { DEFAULT_SUMMARY_MAX_CHARS, emptyAccounting, toDelegateResult } from "./result.js";
import type { DelegateResult } from "./types.js";

/** Bounded await: rejects with `onTimeout` after `ms` unless `promise` settles first. */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: Error): Promise<T> {
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

export interface BackgroundDelegateStartInput {
	bridge: RpcDelegateBridge;
	task: string;
	timeoutMs: number;
	name?: string;
	model?: string;
	summaryMaxChars?: number;
}

export interface BackgroundDelegateEntry {
	handle: string;
	status: "running" | "done" | "error" | "timeout";
	task: string;
	name?: string;
	model?: string;
	startedAt: number;
	completedAt?: number;
	resultFile: string;
	result?: DelegateResult;
}

export class BackgroundDelegateRegistry {
	private readonly entries = new Map<string, BackgroundDelegateEntry>();
	private readonly settled = new Map<string, Promise<void>>();
	private readonly bridges = new Map<string, RpcDelegateBridge>();

	constructor(private readonly resultsDir: string) {
		mkdirSync(resultsDir, { recursive: true });
	}

	/** Detach a helper run; returns immediately with the entry (status running). */
	start(input: BackgroundDelegateStartInput): BackgroundDelegateEntry {
		const handle = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
		const entry: BackgroundDelegateEntry = {
			handle,
			status: "running",
			task: input.task,
			name: input.name,
			model: input.model,
			startedAt: Date.now(),
			resultFile: join(this.resultsDir, `${handle}.json`),
		};
		this.entries.set(handle, entry);
		this.bridges.set(handle, input.bridge);
		let settle!: () => void;
		this.settled.set(
			handle,
			new Promise<void>((resolve) => {
				settle = resolve;
			}),
		);
		void this._run(entry, input, settle);
		return entry;
	}

	get(handle: string): BackgroundDelegateEntry | undefined {
		return this.entries.get(handle);
	}

	list(): BackgroundDelegateEntry[] {
		return [...this.entries.values()];
	}

	/** Wait up to `waitMs` for a running run to settle, then return the entry. */
	async collect(handle: string, waitMs?: number): Promise<BackgroundDelegateEntry | undefined> {
		const entry = this.entries.get(handle);
		if (!entry) {
			return undefined;
		}
		if (entry.status === "running" && typeof waitMs === "number" && waitMs > 0) {
			await Promise.race([this.settled.get(handle), new Promise((resolve) => setTimeout(resolve, waitMs))]);
		}
		return this.entries.get(handle);
	}

	/** Reap every running helper (session_shutdown hygiene). */
	async shutdown(): Promise<void> {
		const stops = [...this.bridges.values()].map((bridge) => bridge.stop().catch(() => undefined));
		this.bridges.clear();
		await Promise.all(stops);
	}

	private async _run(
		entry: BackgroundDelegateEntry,
		input: BackgroundDelegateStartInput,
		settle: () => void,
	): Promise<void> {
		const { bridge, task, timeoutMs } = input;
		const summaryMaxChars = input.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
		let result: DelegateResult;
		try {
			await bridge.start();
			const run = await withTimeout(
				bridge.runTask(task, timeoutMs),
				timeoutMs,
				new Error(`delegate timed out after ${timeoutMs}ms`),
			);
			result = toDelegateResult(
				{
					ok: true,
					summary: run.lastAssistantText,
					tokens: run.stats.tokens ?? emptyAccounting(),
					cost: run.stats.cost,
					helper: { name: input.name, model: input.model, sessionId: run.stats.sessionId },
				},
				summaryMaxChars,
			);
		} catch (error) {
			const isTimeout = error instanceof Error && error.message.startsWith("delegate timed out");
			entry.status = isTimeout ? "timeout" : "error";
			result = toDelegateResult(
				{ ok: false, error: error instanceof Error ? error.message : String(error) },
				summaryMaxChars,
			);
		} finally {
			await bridge.stop().catch(() => undefined);
			this.bridges.delete(entry.handle);
		}
		if (entry.status === "running") {
			entry.status = "done";
		}
		entry.result = result;
		entry.completedAt = Date.now();
		this._writeResultFile(entry, result);
		settle();
	}

	private _writeResultFile(entry: BackgroundDelegateEntry, result: DelegateResult): void {
		try {
			writeFileSync(
				entry.resultFile,
				JSON.stringify(
					{
						handle: entry.handle,
						status: entry.status,
						task: entry.task,
						startedAt: entry.startedAt,
						completedAt: entry.completedAt,
						result,
					},
					null,
					2,
				),
			);
		} catch {
			// Best-effort artifact; the registry entry stays authoritative.
		}
	}
}

/** Compact text returned to the model when a background run starts. */
export function renderBackgroundStarted(entry: BackgroundDelegateEntry): string {
	return [
		`[delegate background] started ${entry.handle}${entry.name ? ` (${entry.name})` : ""} — "${entry.task}"`,
		`Result file: ${entry.resultFile}`,
		`Collect later with delegate(handle="${entry.handle}") or read the result file when it exists.`,
	].join("\n");
}

/** Compact text for a background batch fan-out (one handle per task). */
export function renderBackgroundBatchStarted(entries: BackgroundDelegateEntry[]): string {
	const lines = [`[delegate background] started ${entries.length} helpers:`];
	for (const entry of entries) {
		lines.push(`- ${entry.handle} — "${entry.task}"`);
	}
	lines.push(
		`Result files under ${entries[0]?.resultFile.slice(0, entries[0].resultFile.lastIndexOf("/")) ?? "?"}; collect each with delegate(handle="<handle>").`,
	);
	return lines.join("\n");
}

/** Compact text when a collected background run is still executing. */
export function renderBackgroundPending(entry: BackgroundDelegateEntry): string {
	const elapsedSeconds = Math.max(0, Math.round((Date.now() - entry.startedAt) / 1000));
	return [
		`[delegate running] ${entry.handle} — "${entry.task}" (started ${elapsedSeconds}s ago)`,
		`Result file: ${entry.resultFile}`,
		`Call delegate(handle="${entry.handle}", waitMs=...) to wait, or read the file when it exists.`,
	].join("\n");
}
