/**
 * Delegate journal: the append-only activity log a delegate helper writes
 * while it runs, so a human at the terminal can watch what the helper does.
 *
 * The journal is a bounded projection of the helper's agent events — assistant
 * text deltas, tool calls, and turns — framed by `start` and `end` records the
 * delegate extension writes itself (the extension owns the run lifecycle and
 * its final status). Every record is one JSON line; every text field is
 * length-capped so a runaway helper can never inflate the file.
 *
 * The journal is best-effort: a failed write never fails the delegation.
 */

import { appendFileSync, readFileSync } from "node:fs";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { DelegateTokenAccounting } from "./types.js";

/** Cap on one assistant text record (a single streamed delta, not the whole run). */
export const DELEGATE_JOURNAL_TEXT_MAX_CHARS = 2000;
/** Cap on the stringified tool arguments in one tool record. */
export const DELEGATE_JOURNAL_ARGS_MAX_CHARS = 300;
/** Cap on a tool name in one tool record. */
export const DELEGATE_JOURNAL_NAME_MAX_CHARS = 80;

/** Final run status the extension records when the helper settles. */
export type DelegateJournalStatus = "done" | "error" | "timeout";

/**
 * One journal record. `t` is the wall-clock time in ms the record was
 * written; records are appended in time order.
 */
export type DelegateJournalRecord =
	| { t: number; type: "start"; task: string; model?: string; name?: string; resultFile?: string }
	| { t: number; type: "turn" }
	| { t: number; type: "assistant"; text: string }
	| { t: number; type: "tool"; name: string; args: string }
	| { t: number; type: "tool_done"; name: string; isError: boolean }
	| {
			t: number;
			type: "end";
			status: DelegateJournalStatus;
			ok: boolean;
			error?: string;
			summary?: string;
			tokens?: DelegateTokenAccounting;
	  };

function cap(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/**
 * Project one agent event into a journal record, or null when the event
 * carries nothing a watcher needs (thinking deltas, lifecycle events the
 * extension owns, non-text message updates).
 */
export function mapAgentEventToJournalRecord(
	event: AgentEvent,
	now: number = Date.now(),
): DelegateJournalRecord | null {
	switch (event.type) {
		case "message_update": {
			if (event.assistantMessageEvent.type !== "text_delta") {
				return null;
			}
			return {
				t: now,
				type: "assistant",
				text: cap(event.assistantMessageEvent.delta, DELEGATE_JOURNAL_TEXT_MAX_CHARS),
			};
		}
		case "tool_execution_start": {
			const args = cap(JSON.stringify(event.args ?? {}), DELEGATE_JOURNAL_ARGS_MAX_CHARS);
			return { t: now, type: "tool", name: cap(event.toolName, DELEGATE_JOURNAL_NAME_MAX_CHARS), args };
		}
		case "tool_execution_end": {
			return {
				t: now,
				type: "tool_done",
				name: cap(event.toolName, DELEGATE_JOURNAL_NAME_MAX_CHARS),
				isError: event.isError,
			};
		}
		case "turn_start": {
			return { t: now, type: "turn" };
		}
		default: {
			return null;
		}
	}
}

/** Find the last record of `type` (end records matter; journals are small). */
export function findLastRecord<T extends DelegateJournalRecord["type"]>(
	records: DelegateJournalRecord[],
	type: T,
): Extract<DelegateJournalRecord, { type: T }> | undefined {
	for (let i = records.length - 1; i >= 0; i -= 1) {
		const record = records[i]!;
		if (record.type === type) {
			return record as Extract<DelegateJournalRecord, { type: T }>;
		}
	}
	return undefined;
}

/** Append-only writer. A failed write is dropped and reported as false. */
export interface DelegateJournalWriter {
	write(record: DelegateJournalRecord): boolean;
}

/**
 * Create a writer that appends one JSON line per record. Synchronous on
 * purpose: delegate event rates are low (stream deltas), and a sync append
 * means a crash never loses a record the extension already reported.
 */
export function createDelegateJournalWriter(path: string): DelegateJournalWriter {
	return {
		write(record: DelegateJournalRecord): boolean {
			try {
				appendFileSync(path, `${JSON.stringify(record)}\n`);
				return true;
			} catch {
				return false;
			}
		},
	};
}

/**
 * Read every complete record from a journal file. A trailing partial line
 * (a write in flight) is dropped so the reader always resyncs to the last
 * whole record; earlier unparseable lines stop the read.
 */
export function readDelegateJournal(path: string): DelegateJournalRecord[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const records: DelegateJournalRecord[] = [];
	const lines = text.split("\n");
	// The final segment is only a complete line when the file ends with "\n".
	const complete = text.endsWith("\n") ? lines.length : lines.length - 1;
	for (let i = 0; i < complete; i += 1) {
		const line = lines[i]!.trim();
		if (line === "") {
			continue;
		}
		try {
			records.push(JSON.parse(line) as DelegateJournalRecord);
		} catch {
			break;
		}
	}
	return records;
}
