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

describe("StreamEditor rollover (long replies)", () => {
	it("rolls the bubble over into a new message when text exceeds the cap", async () => {
		vi.useFakeTimers();
		const edits: string[] = [];
		const rollovers: string[] = [];
		const editor = new StreamEditor({
			edit: async (t) => void edits.push(t),
			minIntervalMs: 100,
			maxTextLength: 10,
			rollover: async (overflow) => void rollovers.push(overflow),
		});
		// First bubble grows toward the cap.
		editor.setTarget("0123456789"); // exactly at cap: no rollover
		await vi.advanceTimersByTimeAsync(0);
		expect(rollovers).toEqual([]);
		expect(edits.at(-1)).toBe("0123456789");
		// One char past the cap: bubble 1 stays at the cap, bubble 2 opens with
		// the tail. The rollover callback delivered the tail to the new bubble,
		// so no redundant identical edit follows (the platform would reject it
		// as "message is not modified").
		editor.setTarget("0123456789a");
		await vi.advanceTimersByTimeAsync(200);
		expect(rollovers).toEqual(["a"]);
		expect(edits.at(-1)).toBe("0123456789");
		// More text edits bubble 2 (the new bubble), never bubble 1.
		editor.setTarget("0123456789abc");
		await vi.advanceTimersByTimeAsync(200);
		expect(edits.at(-1)).toBe("abc");
		expect(await editor.finish()).toBe(true);
		expect(edits.at(-1)).toBe("abc");
	});

	it("rolls over again when a second bubble also exceeds the cap", async () => {
		vi.useFakeTimers();
		const edits: string[] = [];
		const rollovers: string[] = [];
		const editor = new StreamEditor({
			edit: async (t) => void edits.push(t),
			minIntervalMs: 0,
			maxTextLength: 5,
			rollover: async (overflow) => void rollovers.push(overflow),
		});
		// 10 chars, cap 5 => bubble 1 "01234" (sealed by edit), bubble 2 "56789"
		// (delivered by the rollover, which is why it is not edited again).
		editor.setTarget("0123456789");
		await vi.advanceTimersByTimeAsync(200);
		expect(rollovers).toEqual(["56789"]);
		expect(edits).toEqual(["01234"]);
		expect(await editor.finish()).toBe(true);
	});

	it("feeds at most one cap of text per rollover when a target jumps several caps", async () => {
		vi.useFakeTimers();
		const rollovers: string[] = [];
		const editor = new StreamEditor({
			edit: async () => {},
			minIntervalMs: 0,
			maxTextLength: 5,
			rollover: async (overflow) => void rollovers.push(overflow),
		});
		editor.setTarget("0123456789abcdef"); // 16 chars, cap 5 => three bubbles
		await vi.advanceTimersByTimeAsync(200);
		expect(rollovers).toEqual(["56789", "abcde", "f"]);
		expect(editor.remainingText()).toBe("f");
		expect(await editor.finish()).toBe(true);
	});

	it("exposes the unlanded tail for the batch fallback", async () => {
		vi.useFakeTimers();
		const editor = new StreamEditor({
			edit: async () => {},
			minIntervalMs: 0,
			maxTextLength: 10,
			rollover: async () => {},
		});
		editor.setTarget("0123456789abc");
		await vi.advanceTimersByTimeAsync(200);
		// Bubble 1 landed "0123456789"; the tail "abc" is the current bubble.
		expect(editor.remainingText()).toBe("abc");
		editor.setTarget("0123456789abcdef");
		await vi.advanceTimersByTimeAsync(200);
		expect(editor.remainingText()).toBe("abcdef");
		expect(await editor.finish()).toBe(true);
		expect(editor.remainingText()).toBe("abcdef");
	});

	it("finish flushes a pending overflow before applying the final text", async () => {
		vi.useFakeTimers();
		const edits: string[] = [];
		const rollovers: string[] = [];
		const editor = new StreamEditor({
			edit: async (t) => void edits.push(t),
			minIntervalMs: 10_000,
			maxTextLength: 10,
			rollover: async (overflow) => void rollovers.push(overflow),
		});
		editor.setTarget("0123456789ab"); // over cap, but never pumped (spacing window)
		const finished = editor.finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(await finished).toBe(true);
		expect(rollovers).toEqual(["ab"]);
		// Bubble 1 was sealed by edit; the tail "ab" was delivered by the
		// rollover, so the final edit is skipped (no "message is not modified").
		expect(edits).toEqual(["0123456789"]);
	});

	it("keeps the whole text as the fallback when a seal edit fails permanently", async () => {
		vi.useFakeTimers();
		const rollovers: string[] = [];
		const editor = new StreamEditor({
			retries: 0,
			minIntervalMs: 50,
			maxTextLength: 10,
			async edit() {
				throw Object.assign(new Error("bad request"), { status: 400 });
			},
			rollover: async (overflow) => void rollovers.push(overflow),
		});
		editor.setTarget("0123456789abcdef");
		await vi.advanceTimersByTimeAsync(500);
		expect(rollovers).toEqual([]); // never sealed => never rolled over
		expect(editor.remainingText()).toBe("0123456789abcdef");
		expect(await editor.finish()).toBe(false); // fallback gets the whole text
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
