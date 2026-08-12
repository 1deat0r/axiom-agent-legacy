import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DeliveryEntry, FileDeliveryLedger, MemoryDeliveryLedger } from "../../src/gateway/delivery-ledger.js";

function entry(over: Partial<DeliveryEntry> = {}): DeliveryEntry {
	return { ts: 1, transport: "telegram", channel: "C1", recipient: "U1", chars: 5, ok: true, ...over };
}

describe("MemoryDeliveryLedger", () => {
	it("records and lists recent entries oldest-first", () => {
		const l = new MemoryDeliveryLedger();
		expect(l.recent(10)).toEqual([]);
		l.record(entry({ ts: 1, channel: "a" }));
		l.record(entry({ ts: 2, channel: "b" }));
		expect(l.recent(10).map((e) => e.channel)).toEqual(["a", "b"]);
		expect(l.recent(1).map((e) => e.channel)).toEqual(["b"]);
	});
	it("caps memory so unbounded growth cannot happen", () => {
		const l = new MemoryDeliveryLedger();
		for (let i = 0; i < 5000; i++) l.record(entry({ ts: i }));
		expect(l.recent(5000).length).toBeLessThanOrEqual(1000);
	});
});

describe("FileDeliveryLedger", () => {
	it("appends JSONL and lists recent entries across instances", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-ledger-"));
		try {
			const file = join(dir, "ledger.jsonl");
			const a = new FileDeliveryLedger(file);
			a.record(entry({ ts: 1, channel: "a", ok: true }));
			a.record(entry({ ts: 2, channel: "b", ok: false, error: "boom" }));
			// A fresh instance seeds from the file (continuity across restarts).
			const b = new FileDeliveryLedger(file);
			expect(b.recent(10).map((e) => e.channel)).toEqual(["a", "b"]);
			expect(b.recent(10)[1]!.ok).toBe(false);
			expect(b.recent(10)[1]!.error).toBe("boom");
			const raw = await readFile(file, "utf8");
			expect(raw.trim().split("\n").length).toBe(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("skips a malformed line and keeps the rest readable", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-ledger-"));
		try {
			const file = join(dir, "ledger.jsonl");
			await mkdir(dir, { recursive: true });
			await import("node:fs/promises").then((fs) => fs.writeFile(file, "{bad json}\n"));
			const a = new FileDeliveryLedger(file);
			a.record(entry({ ts: 9, channel: "good" }));
			const b = new FileDeliveryLedger(file);
			expect(b.recent(10).map((e) => e.channel)).toEqual(["good"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("starts empty when the file is missing and keeps the in-memory cap", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-ledger-"));
		try {
			const file = join(dir, "missing.jsonl");
			const a = new FileDeliveryLedger(file);
			expect(a.recent(5)).toEqual([]);
			for (let i = 0; i < 5000; i++) a.record(entry({ ts: i }));
			expect(a.recent(5000).length).toBeLessThanOrEqual(1000);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
