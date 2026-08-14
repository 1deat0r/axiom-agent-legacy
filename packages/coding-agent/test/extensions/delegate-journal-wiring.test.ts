import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { fromAny } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import type { SessionStats } from "../../src/core/session-stats.js";
import type { RpcDelegateBridge, RpcDelegateRunResult } from "../../src/extensions/delegate/bridge.js";
import { createDelegateExtension } from "../../src/extensions/delegate/index.js";
import { type DelegateJournalRecord, readDelegateJournal } from "../../src/extensions/delegate/journal.js";

function stats(): SessionStats {
	return {
		sessionFile: undefined,
		sessionId: "s",
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 1,
		toolResults: 1,
		totalMessages: 3,
		tokens: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, total: 60 },
		cost: 0.0012,
	};
}

class EmittingStubBridge implements RpcDelegateBridge {
	onEvent?: (event: AgentEvent) => void;
	runError: Error | null = null;
	hang = false;

	async start(): Promise<void> {}
	async runTask(_task: string, _timeoutMs: number): Promise<RpcDelegateRunResult> {
		if (this.hang) {
			return new Promise<RpcDelegateRunResult>(() => undefined);
		}
		this.onEvent?.(fromAny<AgentEvent, unknown>({ type: "turn_start" }));
		this.onEvent?.(
			fromAny<AgentEvent, unknown>({
				type: "message_update",
				message: {},
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" },
			}),
		);
		if (this.runError) {
			throw this.runError;
		}
		return { lastAssistantText: "done summary", stats: stats() };
	}
	async stop(): Promise<void> {}
}

function fakePi() {
	const tools: Array<{
		name: string;
		execute?: (id: string, p: unknown, s?: unknown, u?: unknown, c?: unknown) => Promise<unknown>;
	}> = [];
	const handlers: Array<{ event: string; handler: (event: unknown) => void }> = [];
	const pi = {
		registerTool: (tool: { name: string; execute: (id: string, p: unknown) => Promise<unknown> }) => {
			tools.push(tool);
		},
		on: (event: string, handler: (event: unknown) => void) => {
			handlers.push({ event, handler });
		},
	};
	return { pi: fromAny<ExtensionAPI, unknown>(pi), tools, handlers };
}

async function waitUntil(cond: () => unknown, timeoutMs = 2000): Promise<void> {
	const startedAt = Date.now();
	for (;;) {
		if (cond()) {
			return;
		}
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("waitUntil timeout");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function tmpResultsDir(): string {
	return mkdtempSync(join(tmpdir(), "delegate-jw-"));
}

describe("delegate journal wiring", () => {
	it("foreground run writes a journal with start, activity, and end records", async () => {
		const { pi, tools } = fakePi();
		const stub = new EmittingStubBridge();
		const resultsDir = tmpResultsDir();
		createDelegateExtension({ bridge: () => stub, resultsDir })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = fromAny<{ details: { journalFile: string; ok: boolean } }, unknown>(
			await tool.execute!("c1", { task: "tidy" }),
		);
		expect(out.details.ok).toBe(true);
		expect(out.details.journalFile).toContain(resultsDir);
		expect(existsSync(out.details.journalFile)).toBe(true);
		const records = readDelegateJournal(out.details.journalFile);
		expect(records[0]).toMatchObject({ type: "start", task: "tidy" });
		expect(records.some((r) => r.type === "assistant" && r.text === "working")).toBe(true);
		const end = fromAny<Extract<DelegateJournalRecord, { type: "end" }>, DelegateJournalRecord>(records.at(-1)!);
		expect(end).toMatchObject({ type: "end", status: "done", ok: true });
		expect(end.summary).toBe("done summary");
	});

	it("foreground failure still writes an end record with the error", async () => {
		const { pi, tools } = fakePi();
		const stub = new EmittingStubBridge();
		stub.runError = new Error("provider refused");
		createDelegateExtension({ bridge: () => stub, resultsDir: tmpResultsDir() })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = fromAny<{ details: { journalFile: string; ok: boolean } }, unknown>(
			await tool.execute!("c1", { task: "do it" }),
		);
		expect(out.details.ok).toBe(false);
		const end = fromAny<Extract<DelegateJournalRecord, { type: "end" }>, DelegateJournalRecord>(
			readDelegateJournal(out.details.journalFile).at(-1)!,
		);
		expect(end).toMatchObject({ type: "end", status: "error", ok: false });
		expect(end.error).toBe("provider refused");
	});

	it("an unwritable journal never fails the delegation", async () => {
		const { pi, tools } = fakePi();
		const stub = new EmittingStubBridge();
		const resultsDir = tmpResultsDir();
		createDelegateExtension({ bridge: () => stub, resultsDir })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		// Registry mkdir'd the dir at construction; removing it makes every append fail.
		rmSync(resultsDir, { recursive: true, force: true });
		const out = fromAny<{ details: { ok: boolean } }, unknown>(await tool.execute!("c1", { task: "t" }));
		expect(out.details.ok).toBe(true);
	});

	it("foreground batch writes one journal per task", async () => {
		const { pi, tools } = fakePi();
		const stub = new EmittingStubBridge();
		createDelegateExtension({ bridge: () => stub, resultsDir: tmpResultsDir() })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = fromAny<{ details: { ok: boolean; journalFiles: string[] } }, unknown>(
			await tool.execute!("c1", { tasks: ["a", "b"] }),
		);
		expect(out.details.ok).toBe(true);
		expect(out.details.journalFiles).toHaveLength(2);
		for (const path of out.details.journalFiles) {
			expect(existsSync(path)).toBe(true);
		}
	});

	it("background run journals to resultsDir/<handle>.journal.jsonl and exposes the path", async () => {
		const { pi, tools } = fakePi();
		const stub = new EmittingStubBridge();
		const resultsDir = tmpResultsDir();
		createDelegateExtension({ bridge: () => stub, resultsDir })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const started = fromAny<{ details: { handle: string; journalFile: string; resultFile: string } }, unknown>(
			await tool.execute!("c1", { task: "long job", background: true }),
		);
		expect(started.details.journalFile).toBe(join(resultsDir, `${started.details.handle}.journal.jsonl`));
		await waitUntil(() => {
			const records = readDelegateJournal(started.details.journalFile);
			return records.some((r) => r.type === "end");
		});
		const records = readDelegateJournal(started.details.journalFile);
		expect(records[0]).toMatchObject({ type: "start", task: "long job", resultFile: started.details.resultFile });
		expect(records.at(-1)).toMatchObject({ type: "end", status: "done", ok: true });
		// The start block tells the model where the journal is.
		expect(started.details.journalFile).toBeTruthy();
	});

	it("background batch journals per handle", async () => {
		const { pi, tools } = fakePi();
		const stub = new EmittingStubBridge();
		const resultsDir = tmpResultsDir();
		createDelegateExtension({ bridge: () => stub, resultsDir })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const out = fromAny<{ details: { handles: string[]; journalFiles: string[] } }, unknown>(
			await tool.execute!("c1", { tasks: ["a", "b"], background: true }),
		);
		expect(out.details.journalFiles).toHaveLength(2);
		await waitUntil(() =>
			out.details.journalFiles.every((path) => readDelegateJournal(path).some((r) => r.type === "end")),
		);
		for (let i = 0; i < out.details.journalFiles.length; i += 1) {
			expect(out.details.journalFiles[i]).toBe(join(resultsDir, `${out.details.handles[i]}.journal.jsonl`));
		}
	});

	it("background timeout writes an end record with status timeout", async () => {
		const { pi, tools } = fakePi();
		const stub = new EmittingStubBridge();
		stub.hang = true;
		createDelegateExtension({ bridge: () => stub, timeoutMs: 50, resultsDir: tmpResultsDir() })(pi);
		const tool = tools.find((t) => t.name === "delegate")!;
		const started = fromAny<{ details: { journalFile: string } }, unknown>(
			await tool.execute!("c1", { task: "hang", background: true }),
		);
		await waitUntil(() => readDelegateJournal(started.details.journalFile).some((r) => r.type === "end"));
		const end = fromAny<Extract<DelegateJournalRecord, { type: "end" }>, DelegateJournalRecord>(
			readDelegateJournal(started.details.journalFile).at(-1)!,
		);
		expect(end).toMatchObject({ type: "end", status: "timeout", ok: false });
		expect(end.error).toContain("timed out");
	});
});
