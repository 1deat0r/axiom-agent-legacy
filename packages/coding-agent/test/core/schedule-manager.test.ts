import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduleManager } from "../../src/core/schedule/manager.js";
import { ScheduleStore } from "../../src/core/schedule/store.js";
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

let dir: string | undefined;
afterEach(() => {
	if (dir) {
		rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	}
});
function scratch(): string {
	dir = mkdtempSync(join(tmpdir(), "schedule-mgr-"));
	return join(dir, "schedule.jsonl");
}

describe("ScheduleManager.sweep", () => {
	it("fires due reminders exactly once and leaves future ones alone", () => {
		const nowMs = 1_500_000;
		const store = new ScheduleStore(scratch());
		const fired: string[] = [];
		const mgr = new ScheduleManager({
			storePath: store.filePath,
			now: () => new Date(nowMs),
			onDue: (r) => fired.push(r.id),
		});
		store.append(reminder({ id: "due", dueAt: 1000 }));
		store.append(reminder({ id: "later", dueAt: 2_000_000 }));
		expect(mgr.sweep()).toBe(1);
		expect(fired).toEqual(["due"]);
		expect(store.read().map((r) => r.id)).toEqual(["later"]);
		// fired reminders are gone: a second sweep finds nothing new.
		expect(mgr.sweep()).toBe(0);
	});

	it("fires a reminder due exactly at the sweep time", () => {
		const nowMs = 1000;
		const store = new ScheduleStore(scratch());
		const fired: string[] = [];
		const mgr = new ScheduleManager({
			storePath: store.filePath,
			now: () => new Date(nowMs),
			onDue: (r) => fired.push(r.id),
		});
		store.append(reminder({ id: "exact", dueAt: 1000 }));
		expect(mgr.sweep()).toBe(1);
		expect(fired).toEqual(["exact"]);
	});

	it("reschedules a recurring reminder to the earliest future slot (missed slots collapse)", () => {
		const nowMs = 400_000;
		const store = new ScheduleStore(scratch());
		const fired: string[] = [];
		const mgr = new ScheduleManager({
			storePath: store.filePath,
			now: () => new Date(nowMs),
			onDue: (r) => fired.push(r.id),
		});
		store.append(reminder({ id: "every", kind: "every", dueAt: 1000, intervalMs: 300_000 }));
		expect(mgr.sweep()).toBe(1);
		expect(fired).toEqual(["every"]);
		const active = store.read();
		expect(active).toHaveLength(1);
		expect(active[0]?.id).toBe("every");
		expect(active[0]?.dueAt).toBe(601_000); // 1000 + 2*300000 = first slot after now
		expect(active[0]?.intervalMs).toBe(300_000);
		expect(mgr.sweep()).toBe(0);
	});

	it("fires a reminder that missed its time while down once on start", () => {
		const nowMs = 900;
		const store = new ScheduleStore(scratch());
		store.append(reminder({ id: "missed", kind: "at", dueAt: 500 }));
		const fired: string[] = [];
		const mgr = new ScheduleManager({
			storePath: store.filePath,
			now: () => new Date(nowMs),
			onDue: (r) => fired.push(r.id),
			pollMs: 60_000,
		});
		mgr.start();
		expect(fired).toEqual(["missed"]);
		expect(store.read()).toEqual([]);
		mgr.stop();
	});

	it("records the fire before delivery, so a crashing delivery never re-fires", () => {
		const nowMs = 20;
		const store = new ScheduleStore(scratch());
		store.append(reminder({ id: "x", dueAt: 10 }));
		let seen: string | undefined;
		const mgr = new ScheduleManager({
			storePath: store.filePath,
			now: () => new Date(nowMs),
			onDue: (r) => {
				seen = r.id;
				throw new Error("delivery crashed");
			},
		});
		expect(() => mgr.sweep()).not.toThrow();
		expect(seen).toBe("x");
		expect(store.read()).toEqual([]);
		expect(mgr.sweep()).toBe(0);
	});

	it("is inert before start and after stop", () => {
		const nowMs = 100;
		const store = new ScheduleStore(scratch());
		store.append(reminder({ id: "due", dueAt: 10 }));
		const fired: string[] = [];
		const mgr = new ScheduleManager({
			storePath: store.filePath,
			now: () => new Date(nowMs),
			onDue: (r) => fired.push(r.id),
		});
		expect(fired).toEqual([]);
		mgr.start();
		mgr.stop();
		// a reminder appended after stop is not fired until the manager runs again
		store.append(reminder({ id: "later", dueAt: 10 }));
		expect(fired).toEqual(["due"]);
	});
});
