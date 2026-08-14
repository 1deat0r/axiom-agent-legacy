import { describe, expect, it } from "vitest";
import type { DelegateJournalRecord } from "../../src/extensions/delegate/journal.js";
import { buildDelegateWatchView, renderDelegateWatchView } from "../../src/extensions/delegate/watch-view.js";

function recordsFixture(): DelegateJournalRecord[] {
	return [
		{ t: 1000, type: "start", task: "tidy the repo", model: "deepseek-v4-pro" },
		{ t: 1100, type: "turn" },
		{ t: 1200, type: "assistant", text: "starting the cleanup" },
		{ t: 1300, type: "tool", name: "bash", args: '{"command":"npm test"}' },
		{ t: 1400, type: "tool_done", name: "bash", isError: false },
		{
			t: 2000,
			type: "end",
			status: "done",
			ok: true,
			summary: "cleanup done",
			tokens: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, total: 60 },
		},
	];
}

describe("buildDelegateWatchView", () => {
	it("derives task, model, status, and tokens from the records", () => {
		const view = buildDelegateWatchView(recordsFixture(), 2000);
		expect(view.task).toBe("tidy the repo");
		expect(view.model).toBe("deepseek-v4-pro");
		expect(view.status).toBe("done");
		expect(view.startedAt).toBe(1000);
		expect(view.tokens).toEqual({ input: 40, output: 20, cacheRead: 0, cacheWrite: 0, total: 60 });
	});

	it("reports running with a live elapsed time when no end record exists", () => {
		const records = recordsFixture().slice(0, 4);
		const view = buildDelegateWatchView(records, 13_000);
		expect(view.status).toBe("running");
		expect(view.elapsedMs).toBe(12_000);
		expect(view.tokens).toBeUndefined();
	});

	it("handles an empty journal (file exists, nothing written yet)", () => {
		const view = buildDelegateWatchView([], 5000);
		expect(view.status).toBe("running");
		expect(view.task).toBe("");
		expect(view.elapsedMs).toBe(0);
	});
});

describe("renderDelegateWatchView", () => {
	it("lays out header, separator, body, and footer in exactly `height` lines", () => {
		const lines = renderDelegateWatchView(recordsFixture(), {
			width: 40,
			height: 10,
			scrollOffset: 0,
			color: false,
			now: 2000,
		});
		expect(lines).toHaveLength(10);
		expect(lines[0]).toBe("task: tidy the repo");
		expect(lines[1]).toContain("status: DONE");
		expect(lines[1]).toContain("1s");
		expect(lines[1]).toContain("tokens: 60 (40/20)");
		expect(lines[2]).toBe("─".repeat(40));
		expect(lines[9]).toBe("finished · q quit · ↑/↓ scroll · g/G jump");
	});

	it("renders activity lines: assistant text, tool calls, tool results, and the end summary", () => {
		const lines = renderDelegateWatchView(recordsFixture(), {
			width: 60,
			height: 12,
			scrollOffset: 0,
			color: false,
			now: 2000,
		});
		const body = lines.slice(3, 11);
		expect(body).toContain("starting the cleanup");
		expect(body.some((line) => line.includes("→ bash"))).toBe(true);
		expect(body.some((line) => line.includes("✓ bash"))).toBe(true);
		expect(body.some((line) => line.includes("summary: cleanup done"))).toBe(true);
		expect(body).toContain("· turn");
	});

	it("pins to the bottom (follow mode) when the body overflows", () => {
		const records: DelegateJournalRecord[] = [
			{ t: 1000, type: "start", task: "big job" },
			...Array.from({ length: 30 }, (_, i) => ({ t: 1100 + i, type: "assistant" as const, text: `line ${i + 1}` })),
			{ t: 3000, type: "end", status: "done", ok: true, summary: "the end" },
		];
		const lines = renderDelegateWatchView(records, {
			width: 40,
			height: 6,
			scrollOffset: 0,
			color: false,
			now: 3000,
		});
		expect(lines).toHaveLength(6);
		expect(lines[3]).toBe("end · done");
		expect(lines[4]).toBe("summary: the end");
		expect(lines.join("\n")).not.toContain("line 1\n");
	});

	it("scrolls back from the bottom by scrollOffset lines", () => {
		const records: DelegateJournalRecord[] = [
			{ t: 1000, type: "start", task: "big job" },
			...Array.from({ length: 30 }, (_, i) => ({ t: 1100 + i, type: "assistant" as const, text: `line ${i + 1}` })),
			{ t: 3000, type: "end", status: "done", ok: true, summary: "the end" },
		];
		const lines = renderDelegateWatchView(records, {
			width: 40,
			height: 6,
			scrollOffset: 1,
			color: false,
			now: 3000,
		});
		expect(lines[3]).toBe("line 30");
		expect(lines[4]).toBe("end · done");
	});

	it("clamps a huge scrollOffset to the top of the body", () => {
		const records: DelegateJournalRecord[] = [
			{ t: 1000, type: "start", task: "big job" },
			...Array.from({ length: 30 }, (_, i) => ({ t: 1100 + i, type: "assistant" as const, text: `line ${i + 1}` })),
			{ t: 3000, type: "end", status: "done", ok: true, summary: "the end" },
		];
		const lines = renderDelegateWatchView(records, {
			width: 40,
			height: 6,
			scrollOffset: 9999,
			color: false,
			now: 3000,
		});
		expect(lines[3]).toBe("line 1");
		expect(lines[4]).toBe("line 2");
	});

	it("renders an error end record with its reason", () => {
		const records: DelegateJournalRecord[] = [
			{ t: 1000, type: "start", task: "doomed" },
			{ t: 1500, type: "end", status: "error", ok: false, error: "provider refused" },
		];
		const lines = renderDelegateWatchView(records, {
			width: 50,
			height: 6,
			scrollOffset: 0,
			color: false,
			now: 1500,
		});
		expect(lines[1]).toContain("status: ERROR");
		expect(lines[1]).not.toContain("tokens:");
		expect(lines[3]).toBe("end · error · provider refused");
		expect(lines[5]).toBe("finished · q quit · ↑/↓ scroll · g/G jump");
	});
});
