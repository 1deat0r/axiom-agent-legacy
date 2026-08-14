import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { foldSchedule, ScheduleStore, scheduleStorePath } from "../../src/core/schedule/store.js";
import type { ScheduleReminder } from "../../src/core/schedule/types.js";

function reminder(overrides: Partial<ScheduleReminder> = {}): ScheduleReminder {
	return {
		id: "r1",
		kind: "after",
		channelId: "+1",
		sessionId: "gw-1",
		text: "hello",
		dueAt: 1000,
		createdAt: 0,
		...overrides,
	};
}

describe("foldSchedule", () => {
	it("keeps scheduled reminders and drops fired ones", () => {
		const folded = foldSchedule([
			{ type: "schedule", reminder: reminder({ id: "a", dueAt: 100 }) },
			{ type: "schedule", reminder: reminder({ id: "b", dueAt: 200 }) },
			{ type: "fire", id: "a", firedAt: 150 },
		]);
		expect(folded.map((r) => r.id)).toEqual(["b"]);
	});

	it("skips malformed lines and lets a later create win for a duplicate id", () => {
		const folded = foldSchedule([
			"not a record",
			{ type: "schedule", reminder: reminder({ id: "a", dueAt: 100, text: "first" }) },
			{ type: "schedule", reminder: reminder({ id: "a", dueAt: 300, text: "second" }) },
			{ type: "fire", id: "missing", firedAt: 0 },
			{ type: "schedule", reminder: { ...reminder({ id: "bad" }), dueAt: Number.NaN } },
		]);
		expect(folded).toHaveLength(1);
		expect(folded[0]?.text).toBe("second");
		expect(folded[0]?.dueAt).toBe(300);
	});

	it("a fire followed by a re-create of the same id (recurring) leaves one active reminder", () => {
		const folded = foldSchedule([
			{ type: "schedule", reminder: reminder({ id: "r", dueAt: 100, intervalMs: 60_000 }) },
			{ type: "fire", id: "r", firedAt: 100 },
			{ type: "schedule", reminder: reminder({ id: "r", dueAt: 160_000, intervalMs: 60_000 }) },
		]);
		expect(folded).toHaveLength(1);
		expect(folded[0]?.dueAt).toBe(160_000);
	});

	it("sorts active reminders by due time", () => {
		const folded = foldSchedule([
			{ type: "schedule", reminder: reminder({ id: "late", dueAt: 900 }) },
			{ type: "schedule", reminder: reminder({ id: "early", dueAt: 100 }) },
		]);
		expect(folded.map((r) => r.id)).toEqual(["early", "late"]);
	});
});

describe("ScheduleStore", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});
	function scratch(): string {
		dir = mkdtempSync(join(tmpdir(), "schedule-store-"));
		return join(dir, "gateway", "schedule.jsonl");
	}

	it("persists reminders across store instances (round trip)", () => {
		const path = scratch();
		const a = new ScheduleStore(path);
		a.append(reminder({ id: "x", dueAt: 500, text: "ping" }));
		a.appendFire("x", 500);
		a.append(reminder({ id: "y", dueAt: 900, text: "later" }));
		const b = new ScheduleStore(path);
		expect(b.read().map((r) => r.id)).toEqual(["y"]);
	});

	it("reads an empty store as no reminders", () => {
		const s = new ScheduleStore(scratch());
		expect(s.read()).toEqual([]);
	});

	it("ignores malformed JSON lines when reading", () => {
		const path = scratch();
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "garbage\n{ broken\n");
		const s = new ScheduleStore(path);
		s.append(reminder({ id: "ok", dueAt: 1 }));
		expect(s.read().map((r) => r.id)).toEqual(["ok"]);
	});

	it("creates the parent directory on first append", () => {
		const path = scratch();
		new ScheduleStore(path).append(reminder({ id: "deep", dueAt: 1 }));
		expect(new ScheduleStore(path).read().map((r) => r.id)).toEqual(["deep"]);
	});
});

describe("scheduleStorePath", () => {
	it("points at gateway/schedule.jsonl under the axiom home", () => {
		expect(scheduleStorePath("/home/u/.axiom")).toBe("/home/u/.axiom/gateway/schedule.jsonl");
	});
});
