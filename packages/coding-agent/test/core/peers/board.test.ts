import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendBoardEntry,
	boardFile,
	boardSize,
	readBoardSince,
	readCursor,
	writeCursor,
} from "../../../src/core/peers/board.js";
import type { BoardEntry } from "../../../src/core/peers/types.js";

function entry(over: Partial<BoardEntry> = {}): BoardEntry {
	return {
		ts: new Date(1_800_000_000_000).toISOString(),
		from: "abc12345-1234-1234-1234-123456789012",
		fromRun: "run-a",
		to: "*",
		kind: "group",
		text: "hello peers",
		...over,
	};
}

describe("board", () => {
	it("appends entries and reads them since a cursor", () => {
		const scope = mkdtempSync(join(tmpdir(), "peers-board-"));
		try {
			expect(boardSize(scope)).toBe(0);
			const first = readBoardSince(scope, 0);
			expect(first.entries).toHaveLength(0);
			expect(first.nextCursor).toBe(0);

			appendBoardEntry(scope, entry({ text: "one" }));
			appendBoardEntry(scope, entry({ text: "two", to: "target-id" }));
			const read = readBoardSince(scope, 0);
			expect(read.entries.map((e) => e.text)).toEqual(["one", "two"]);
			expect(read.nextCursor).toBe(boardSize(scope));

			const tail = readBoardSince(scope, read.nextCursor);
			expect(tail.entries).toHaveLength(0);
			expect(tail.nextCursor).toBe(read.nextCursor);
		} finally {
			rmSync(scope, { recursive: true, force: true });
		}
	});

	it("persists cursors per instance", () => {
		const scope = mkdtempSync(join(tmpdir(), "peers-board-"));
		try {
			appendBoardEntry(scope, entry({ text: "one" }));
			const cursor = boardSize(scope);
			writeCursor(scope, "inst-a", cursor);
			expect(readCursor(scope, "inst-a")).toBe(cursor);
			expect(readCursor(scope, "inst-b")).toBe(0);
		} finally {
			rmSync(scope, { recursive: true, force: true });
		}
	});

	it("skips malformed lines but still advances the cursor", () => {
		const scope = mkdtempSync(join(tmpdir(), "peers-board-"));
		try {
			writeFileSync(boardFile(scope), "{broken json\n");
			appendBoardEntry(scope, entry({ text: "after junk" }));
			const read = readBoardSince(scope, 0);
			expect(read.entries.map((e) => e.text)).toEqual(["after junk"]);
			expect(read.nextCursor).toBe(boardSize(scope));
		} finally {
			rmSync(scope, { recursive: true, force: true });
		}
	});
});
