import { afterEach, describe, expect, it, vi } from "vitest";
import { isRetryableEditError, StreamEditor } from "../../src/gateway/stream-editor.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("StreamEditor", () => {
	it("coalesces a burst of updates into spaced edits ending on the final text", async () => {
		vi.useFakeTimers();
		const edits: string[] = [];
		const editor = new StreamEditor({ edit: async (t) => void edits.push(t), minIntervalMs: 100 });
		editor.setTarget("a");
		editor.setTarget("ab");
		editor.setTarget("abc");
		await vi.advanceTimersByTimeAsync(0);
		expect(edits).toEqual(["abc"]); // one immediate edit carrying the latest text
		editor.setTarget("abcd");
		editor.setTarget("abcde");
		await vi.advanceTimersByTimeAsync(99);
		expect(edits).toEqual(["abc"]); // still inside the spacing window
		await vi.advanceTimersByTimeAsync(1);
		expect(edits).toEqual(["abc", "abcde"]);
		expect(await editor.finish()).toBe(true);
	});

	it("serializes edits: at most one in flight and slow edits never clobber newer text", async () => {
		vi.useFakeTimers();
		let inFlight = 0;
		let maxInFlight = 0;
		const applied: string[] = [];
		const editor = new StreamEditor({
			minIntervalMs: 50,
			async edit(text) {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 30)); // slower than the spacing window
				inFlight -= 1;
				applied.push(text);
			},
		});
		editor.setTarget("one");
		editor.setTarget("one two");
		await vi.advanceTimersByTimeAsync(0); // first edit starts
		editor.setTarget("one two three");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await editor.finish()).toBe(true);
		expect(maxInFlight).toBe(1);
		expect(applied.at(-1)).toBe("one two three");
		// Never regresses: the shown text only ever grows toward the target.
		for (let i = 1; i < applied.length; i++) {
			expect(applied[i]!.length).toBeGreaterThan(applied[i - 1]!.length);
		}
	});

	it("finish flushes the pending text immediately without the spacing throttle", async () => {
		vi.useFakeTimers();
		const edits: string[] = [];
		const editor = new StreamEditor({ edit: async (t) => void edits.push(t), minIntervalMs: 1_000 });
		editor.setTarget("slow");
		await vi.advanceTimersByTimeAsync(0);
		expect(edits).toEqual(["slow"]);
		editor.setTarget("slow fast");
		const finished = editor.finish();
		await vi.advanceTimersByTimeAsync(0); // no 1000ms wait needed
		expect(await finished).toBe(true);
		expect(edits).toEqual(["slow", "slow fast"]);
	});

	it("returns false when the final edit fails after retries", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const editor = new StreamEditor({
			retries: 2,
			async edit() {
				calls += 1;
				throw Object.assign(new Error("flood"), { status: 429 });
			},
		});
		editor.setTarget("final");
		const finished = editor.finish();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await finished).toBe(false);
		expect(calls).toBe(3); // 1 attempt + 2 retries
	});

	it("does not retry permanent errors", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const editor = new StreamEditor({
			retries: 5,
			async edit() {
				calls += 1;
				throw Object.assign(new Error("bad request"), { status: 400 });
			},
		});
		editor.setTarget("x");
		const finished = editor.finish();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await finished).toBe(false);
		expect(calls).toBe(1);
	});

	it("ignores updates after finish", async () => {
		vi.useFakeTimers();
		const edits: string[] = [];
		const editor = new StreamEditor({ edit: async (t) => void edits.push(t) });
		expect(await editor.finish()).toBe(true);
		editor.setTarget("late");
		await vi.advanceTimersByTimeAsync(100);
		expect(edits).toEqual([]);
	});
});

describe("isRetryableEditError", () => {
	it("retries flood-control and server errors only", () => {
		expect(isRetryableEditError({ status: 429 })).toBe(true);
		expect(isRetryableEditError({ status: 500 })).toBe(true);
		expect(isRetryableEditError({ status: 502 })).toBe(true);
		expect(isRetryableEditError({ status: 400 })).toBe(false);
		expect(isRetryableEditError({ status: 401 })).toBe(false);
		expect(isRetryableEditError({ status: 409 })).toBe(false);
		expect(isRetryableEditError(new Error("network down"))).toBe(false);
	});
});
