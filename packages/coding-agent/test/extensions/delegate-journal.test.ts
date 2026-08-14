import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { fromAny } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import type { DelegateJournalRecord } from "../../src/extensions/delegate/journal.js";
import {
	createDelegateJournalWriter,
	DELEGATE_JOURNAL_ARGS_MAX_CHARS,
	DELEGATE_JOURNAL_TEXT_MAX_CHARS,
	mapAgentEventToJournalRecord,
	readDelegateJournal,
} from "../../src/extensions/delegate/journal.js";

describe("mapAgentEventToJournalRecord", () => {
	it("maps an assistant text delta to an assistant record", () => {
		const event = fromAny<AgentEvent, unknown>({
			type: "message_update",
			message: {},
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello " },
		});
		expect(mapAgentEventToJournalRecord(event, 100)).toEqual({ t: 100, type: "assistant", text: "hello " });
	});

	it("caps assistant text to DELEGATE_JOURNAL_TEXT_MAX_CHARS", () => {
		const long = "x".repeat(DELEGATE_JOURNAL_TEXT_MAX_CHARS + 500);
		const event = fromAny<AgentEvent, unknown>({
			type: "message_update",
			message: {},
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: long },
		});
		const record = fromAny<Extract<DelegateJournalRecord, { type: "assistant" }>, DelegateJournalRecord>(
			mapAgentEventToJournalRecord(event, 1)!,
		);
		expect(record.type).toBe("assistant");
		expect(record.text.length).toBe(DELEGATE_JOURNAL_TEXT_MAX_CHARS);
	});

	it("skips thinking deltas and other non-text message updates", () => {
		const thinking = fromAny<AgentEvent, unknown>({
			type: "message_update",
			message: {},
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "ponder" },
		});
		expect(mapAgentEventToJournalRecord(thinking)).toBeNull();
		const toolcall = fromAny<AgentEvent, unknown>({
			type: "message_update",
			message: {},
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "x" },
		});
		expect(mapAgentEventToJournalRecord(toolcall)).toBeNull();
	});

	it("maps a tool start to a tool record with capped stringified args", () => {
		const args = { command: "npm test", extra: "z".repeat(DELEGATE_JOURNAL_ARGS_MAX_CHARS + 40) };
		const event = fromAny<AgentEvent, unknown>({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "bash",
			args,
		});
		const record = fromAny<Extract<DelegateJournalRecord, { type: "tool" }>, DelegateJournalRecord>(
			mapAgentEventToJournalRecord(event, 7)!,
		);
		expect(record.type).toBe("tool");
		expect(record.name).toBe("bash");
		expect(record.args.length).toBe(DELEGATE_JOURNAL_ARGS_MAX_CHARS);
		expect(record.args).toContain("npm test");
	});

	it("maps a tool end with its error flag", () => {
		const event = fromAny<AgentEvent, unknown>({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: {},
			isError: true,
		});
		expect(mapAgentEventToJournalRecord(event, 9)).toEqual({ t: 9, type: "tool_done", name: "bash", isError: true });
	});

	it("maps turn starts and drops lifecycle events the extension owns", () => {
		expect(mapAgentEventToJournalRecord(fromAny<AgentEvent, unknown>({ type: "turn_start" }), 3)).toEqual({
			t: 3,
			type: "turn",
		});
		expect(mapAgentEventToJournalRecord(fromAny<AgentEvent, unknown>({ type: "agent_start" }))).toBeNull();
		expect(
			mapAgentEventToJournalRecord(fromAny<AgentEvent, unknown>({ type: "agent_end", messages: [] })),
		).toBeNull();
	});
});

describe("createDelegateJournalWriter", () => {
	it("appends one JSON line per record in order", () => {
		const dir = mkdtempSync(join(tmpdir(), "delegate-journal-"));
		const path = join(dir, "h1.journal.jsonl");
		const writer = createDelegateJournalWriter(path);
		expect(writer.write({ t: 1, type: "start", task: "job" })).toBe(true);
		expect(writer.write({ t: 2, type: "assistant", text: "hi" })).toBe(true);
		const lines = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toEqual({ t: 1, type: "start", task: "job" });
		rmSync(dir, { recursive: true, force: true });
	});

	it("never throws when the path is unwritable (best-effort journal)", () => {
		const writer = createDelegateJournalWriter("/nonexistent-dir-xyz/j.journal.jsonl");
		expect(() => writer.write({ t: 1, type: "turn" })).not.toThrow();
		expect(writer.write({ t: 1, type: "turn" })).toBe(false);
	});
});

describe("readDelegateJournal", () => {
	it("reads complete records and resyncs on a truncated trailing line", () => {
		const dir = mkdtempSync(join(tmpdir(), "delegate-journal-"));
		const path = join(dir, "h2.journal.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({ t: 1, type: "start", task: "job" })}\n${JSON.stringify({ t: 2, type: "turn" })}\n{"t":3,"type":"assis`,
		);
		const records = readDelegateJournal(path);
		expect(records).toHaveLength(2);
		expect(records[1]).toEqual({ t: 2, type: "turn" });
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns [] for a missing file", () => {
		expect(readDelegateJournal("/nonexistent-dir-xyz/j.journal.jsonl")).toEqual([]);
	});
});
