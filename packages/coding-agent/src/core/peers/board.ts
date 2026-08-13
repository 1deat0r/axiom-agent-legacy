/**
 * The board: one append-only JSONL file per scope that carries every message
 * (directed and group). Each instance keeps a byte-offset cursor and tails the
 * board, so no fan-out or inbox files are needed and group chat with any
 * number of participants falls out for free. Malformed lines are skipped but
 * the cursor still advances — a bad line must not wedge the tail.
 */

import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardEntry } from "./types.js";

export interface BoardDeps {
	append?: (path: string, data: string) => void;
	statSize?: (path: string) => number;
	readSlice?: (path: string, start: number, end: number) => string;
	writeFile?: (path: string, data: string) => void;
	rename?: (from: string, to: string) => void;
}

export function boardFile(scope: string): string {
	return join(scope, "board.jsonl");
}

export function cursorFile(scope: string, instanceId: string): string {
	return join(scope, `cursor-${instanceId}.json`);
}

/** Append one entry. O_APPEND writes of small lines are atomic per call. */
export function appendBoardEntry(scope: string, entry: BoardEntry, deps: BoardDeps = {}): void {
	const append = deps.append ?? ((path, data) => appendFileSync(path, data, { encoding: "utf8", flag: "a" }));
	append(boardFile(scope), `${JSON.stringify(entry)}\n`);
}

export function boardSize(scope: string, deps: BoardDeps = {}): number {
	const statSize =
		deps.statSize ??
		((path) => {
			try {
				return statSync(path).size;
			} catch {
				return 0;
			}
		});
	return statSize(boardFile(scope));
}

export interface ReadBoardResult {
	entries: BoardEntry[];
	nextCursor: number;
}

/** Read all entries between the cursor and the current board size. */
export function readBoardSince(scope: string, cursor: number, deps: BoardDeps = {}): ReadBoardResult {
	const size = boardSize(scope, deps);
	const start = Math.max(0, Math.min(cursor, size));
	if (start >= size) return { entries: [], nextCursor: start };
	const readSlice = deps.readSlice ?? ((path, from, to) => readFileSync(path, "utf8").slice(from, to));
	const chunk = readSlice(boardFile(scope), start, size);
	const entries: BoardEntry[] = [];
	// The slice starts at a line boundary, so every char belongs to whole
	// lines except possibly a trailing partial line from an in-flight append.
	let consumed = chunk.length;
	if (consumed > 0 && !chunk.endsWith("\n")) {
		const lastNewline = chunk.lastIndexOf("\n");
		consumed = lastNewline < 0 ? 0 : lastNewline + 1;
	}
	for (const line of chunk.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as Partial<BoardEntry>;
			if (
				typeof parsed.ts === "string" &&
				typeof parsed.from === "string" &&
				typeof parsed.to === "string" &&
				typeof parsed.text === "string"
			) {
				entries.push({
					ts: parsed.ts,
					from: parsed.from,
					fromRun: typeof parsed.fromRun === "string" ? parsed.fromRun : "",
					to: parsed.to,
					kind: parsed.kind === "group" ? "group" : "msg",
					text: parsed.text,
				});
			}
		} catch {
			// Malformed line: skip but keep the cursor moving.
		}
	}
	return { entries, nextCursor: start + consumed };
}

export function readCursor(scope: string, instanceId: string, deps: BoardDeps = {}): number {
	const readSlice =
		deps.readSlice ??
		((path, from, to) => {
			try {
				return readFileSync(path, "utf8").slice(from, to);
			} catch {
				return "";
			}
		});
	try {
		const parsed = JSON.parse(readSlice(cursorFile(scope, instanceId), 0, Number.POSITIVE_INFINITY)) as {
			offset?: unknown;
		};
		return typeof parsed.offset === "number" && Number.isFinite(parsed.offset) && parsed.offset >= 0
			? parsed.offset
			: 0;
	} catch {
		return 0;
	}
}

export function writeCursor(scope: string, instanceId: string, offset: number, deps: BoardDeps = {}): void {
	const writeFile = deps.writeFile ?? ((path, data) => writeFileSync(path, data, "utf8"));
	const rename = deps.rename ?? ((from, to) => renameSync(from, to));
	const tmp = `${cursorFile(scope, instanceId)}.tmp`;
	writeFile(tmp, JSON.stringify({ offset }));
	rename(tmp, cursorFile(scope, instanceId));
}
