import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScheduleStore } from "../../src/core/schedule/store.js";
import type { ScheduleReminder } from "../../src/core/schedule/types.js";
import { MemoryChannelIndex } from "../../src/gateway/channel-index.js";
import { fakeCompletionRunner } from "../../src/gateway/completion.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { CompletionRunner, GatewayMessage, GatewayRecipient, GatewayTransport } from "../../src/gateway/types.js";

function fakeTransport() {
	const sent: Array<{ to: string; text: string }> = [];
	let handler: ((msg: GatewayMessage) => void) | undefined;
	const t: GatewayTransport = {
		async connect() {},
		async disconnect() {},
		async send(to: GatewayRecipient, text: string) {
			sent.push({ to: to.recipient, text });
		},
		onMessage(h: (msg: GatewayMessage) => void) {
			handler = h;
		},
	};
	return { t, sent, push: (m: GatewayMessage) => handler?.(m) };
}

/** A runner whose completions stay pending until the test resolves them. */
function manualRunner() {
	const calls: Array<{ sessionId: string; prompt: string; channelId?: string }> = [];
	const gates: Array<() => void> = [];
	const runner: CompletionRunner = {
		async runCompletion(input) {
			calls.push({ sessionId: input.sessionId, prompt: input.prompt, channelId: input.channelId });
			await new Promise<void>((resolve) => gates.push(resolve));
			return { reply: `reply to: ${input.prompt}`, sessionId: input.sessionId };
		},
	};
	return { runner, calls, gates };
}

function reminder(overrides: Partial<ScheduleReminder> = {}): ScheduleReminder {
	return {
		id: "r1",
		kind: "after",
		channelId: "+1",
		sessionId: "gw-deadbeef",
		text: "remind me to stretch",
		dueAt: Date.now() - 1000,
		createdAt: Date.now() - 60_000,
		...overrides,
	};
}

async function settle(ms = 30): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

describe("Gateway schedule turns", () => {
	it("a due reminder runs as an ordinary turn in its session and delivers to its channel", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gw-sched-"));
		try {
			const { t, sent } = fakeTransport();
			const completion = fakeCompletionRunner();
			const storePath = join(dir, "schedule.jsonl");
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				schedule: { storePath, pollMs: 60_000 },
			});
			await g.start();
			new ScheduleStore(storePath).append(reminder({ sessionId: "gw-deadbeef", text: "remind me to stretch" }));
			expect(g.sweepSchedule()).toBe(1);
			await settle();
			expect(
				completion.calls.some(
					(c) => c.sessionId === "gw-deadbeef" && c.prompt === "remind me to stretch" && c.channelId === "+1",
				),
			).toBe(true);
			expect(sent.some((s) => s.text === "axiom reply to: remind me to stretch")).toBe(true);
			// fired exactly once
			expect(g.sweepSchedule()).toBe(0);
			expect(completion.calls.filter((c) => c.prompt === "remind me to stretch")).toHaveLength(1);
			await g.stop();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a recurring reminder fires again only at its next slot", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gw-sched-"));
		try {
			const { t } = fakeTransport();
			const completion = fakeCompletionRunner();
			const storePath = join(dir, "schedule.jsonl");
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				schedule: { storePath, pollMs: 60_000 },
			});
			await g.start();
			new ScheduleStore(storePath).append(
				reminder({ id: "every", kind: "every", intervalMs: 300_000, dueAt: Date.now() - 1000 }),
			);
			expect(g.sweepSchedule()).toBe(1);
			await settle();
			const active = new ScheduleStore(storePath).read();
			expect(active).toHaveLength(1);
			expect(active[0]?.id).toBe("every");
			expect(active[0]?.dueAt).toBeGreaterThan(Date.now());
			expect(g.sweepSchedule()).toBe(0);
			expect(completion.calls.filter((c) => c.prompt === "remind me to stretch")).toHaveLength(1);
			await g.stop();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a reminder queued while an interactive turn is running waits its turn (per-channel serialization)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gw-sched-"));
		try {
			const { t, push } = fakeTransport();
			const { runner, calls, gates } = manualRunner();
			const storePath = join(dir, "schedule.jsonl");
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion: runner,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				schedule: { storePath, pollMs: 60_000 },
			});
			await g.start();
			push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 1 });
			await settle();
			expect(calls).toHaveLength(1);
			new ScheduleStore(storePath).append(reminder({ sessionId: "gw-1" }));
			expect(g.sweepSchedule()).toBe(1);
			await settle();
			// the reminder turn is queued behind the interactive run
			expect(calls).toHaveLength(1);
			gates[0]?.();
			await settle();
			expect(calls).toHaveLength(2);
			expect(calls[1]).toMatchObject({ sessionId: "gw-1", prompt: "remind me to stretch", channelId: "+1" });
			gates[1]?.();
			await settle();
			await g.stop();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a reminder that missed its time while down fires once on gateway start", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gw-sched-"));
		try {
			const { t } = fakeTransport();
			const completion = fakeCompletionRunner();
			const storePath = join(dir, "schedule.jsonl");
			new ScheduleStore(storePath).append(reminder({ id: "missed", dueAt: Date.now() - 5 * 60_000 }));
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				schedule: { storePath, pollMs: 60_000 },
			});
			await g.start();
			await settle();
			expect(completion.calls.filter((c) => c.prompt === "remind me to stretch")).toHaveLength(1);
			expect(new ScheduleStore(storePath).read()).toEqual([]);
			await g.stop();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
