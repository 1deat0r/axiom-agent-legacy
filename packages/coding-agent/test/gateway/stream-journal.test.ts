import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	FileStreamJournal,
	INTERRUPTED_STREAM_NOTICE,
	recoverInterruptedStreams,
} from "../../src/gateway/stream-journal.js";
import type { GatewayTransport } from "../../src/gateway/types.js";

async function home(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

/** A transport that can edit bubbles and records every edit. */
function fakeEditTransport() {
	const edits: Array<{ chatId: string; messageId: number; text: string }> = [];
	let fail = false;
	const t: GatewayTransport = {
		async connect() {},
		async disconnect() {},
		async send() {},
		async editMessage(chatId, messageId, text) {
			if (fail) throw new Error("edit failed");
			edits.push({ chatId, messageId, text });
		},
		onMessage() {},
	};
	return {
		t,
		edits,
		setFail(v: boolean) {
			fail = v;
		},
	};
}

describe("FileStreamJournal", () => {
	it("persists records across instances, dedupes by channel+message, removes and clears", async () => {
		const dir = await home("axiom-sj-");
		try {
			const path = join(dir, "streams.jsonl");
			const a = new FileStreamJournal(path);
			a.add({ channelId: "7", messageId: 11, startedAt: 1 });
			a.add({ channelId: "7", messageId: 11, startedAt: 2 }); // same key: replaced
			a.add({ channelId: "8", messageId: 22, startedAt: 3 });
			const b = new FileStreamJournal(path);
			expect(b.load()).toHaveLength(2);
			expect(b.load().find((r) => r.channelId === "7")?.startedAt).toBe(2);
			b.remove("7", 11);
			expect(b.load()).toEqual([{ channelId: "8", messageId: 22, startedAt: 3 }]);
			b.remove("7", 11); // already gone: no-op, no error
			expect(b.load()).toHaveLength(1);
			b.clear();
			expect(b.load()).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("skips malformed lines and partial records", async () => {
		const dir = await home("axiom-sj-");
		try {
			const path = join(dir, "streams.jsonl");
			writeFileSync(path, 'not json\n{"channelId":"7","messageId":11,"startedAt":1}\n{"messageId":12}\n', "utf8");
			const journal = new FileStreamJournal(path);
			expect(journal.load()).toEqual([{ channelId: "7", messageId: 11, startedAt: 1 }]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("recoverInterruptedStreams", () => {
	it("edits every stale record into an interruption notice and clears the journal", async () => {
		const dir = await home("axiom-sj-");
		try {
			const path = join(dir, "streams.jsonl");
			const journal = new FileStreamJournal(path);
			journal.add({ channelId: "7", messageId: 11, startedAt: 1 });
			journal.add({ channelId: "8", messageId: 22, startedAt: 2 });
			const { t, edits } = fakeEditTransport();
			const logs: string[] = [];
			await recoverInterruptedStreams(t, journal, (line) => logs.push(line));
			expect(edits).toHaveLength(2);
			expect(edits[0]).toEqual({ chatId: "7", messageId: 11, text: INTERRUPTED_STREAM_NOTICE });
			expect(edits[1]).toEqual({ chatId: "8", messageId: 22, text: INTERRUPTED_STREAM_NOTICE });
			expect(journal.load()).toEqual([]);
			expect(logs).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("retries a failing edit once, logs the failure, and still clears the journal", async () => {
		const dir = await home("axiom-sj-");
		try {
			const path = join(dir, "streams.jsonl");
			const journal = new FileStreamJournal(path);
			journal.add({ channelId: "7", messageId: 11, startedAt: 1 });
			const { t, setFail } = fakeEditTransport();
			setFail(true);
			const logs: string[] = [];
			await recoverInterruptedStreams(t, journal, (line) => logs.push(line));
			expect(journal.load()).toEqual([]);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toContain("stream recovery failed");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("clears without editing when the transport has no in-place edits", async () => {
		const dir = await home("axiom-sj-");
		try {
			const path = join(dir, "streams.jsonl");
			const journal = new FileStreamJournal(path);
			journal.add({ channelId: "7", messageId: 11, startedAt: 1 });
			const t: GatewayTransport = {
				async connect() {},
				async disconnect() {},
				async send() {},
				onMessage() {},
			};
			await recoverInterruptedStreams(t, journal, () => {});
			expect(journal.load()).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("is a no-op when the journal is empty", async () => {
		const dir = await home("axiom-sj-");
		try {
			const path = join(dir, "streams.jsonl");
			const journal = new FileStreamJournal(path);
			const { t, edits } = fakeEditTransport();
			await recoverInterruptedStreams(t, journal, () => {});
			expect(edits).toEqual([]);
			expect(journal.load()).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
