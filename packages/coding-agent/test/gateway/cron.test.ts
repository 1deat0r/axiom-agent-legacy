import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentCronJob } from "../../src/core/cron-jobs.js";
import { GatewayCron } from "../../src/gateway/cron.js";
import type { CompletionRunner, GatewayTransport } from "../../src/gateway/types.js";

/** Records completions and sends; configured per test for error paths. */
function harness() {
	const calls: Array<{ sessionId: string; prompt: string }> = [];
	const sends: Array<{ channelId: string; text: string }> = [];
	const completion: CompletionRunner = {
		async runCompletion(input) {
			calls.push({ sessionId: input.sessionId, prompt: input.prompt });
			return { reply: `reply to: ${input.prompt}`, sessionId: input.sessionId };
		},
	};
	const transport: GatewayTransport = {
		async connect() {},
		async disconnect() {},
		async send(to, text) {
			sends.push({ channelId: to.channelId, text });
		},
		onMessage() {},
	};
	return { calls, sends, completion, transport };
}

/** A bare cron job for direct runJob invocation. */
function job(overrides: Partial<AgentCronJob> = {}): AgentCronJob {
	const base: AgentCronJob = {
		id: "job-1",
		status: "active",
		source: "cron",
		channelId: "100",
		activeSessionId: "sid",
		sessionId: "sid",
		sessionFile: "/tmp/s.jsonl",
		cwd: "/tmp",
		prompt: "do the thing",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		runCount: 0,
	};
	return { ...base, ...overrides };
}

function newCron(dir: string, h: ReturnType<typeof harness>): GatewayCron {
	return new GatewayCron({ storePath: join(dir, "cron-jobs.json"), ...h, profile: "default", projectHome: dir });
}

describe("gateway cron manager", () => {
	it("addJob persists a profile-scoped cron job with the channel and a next run", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-cron-"));
		try {
			const h = harness();
			const added = newCron(dir, h).addJob({ channelId: "100", scheduleText: "in 5m", prompt: "remind me" });
			expect(added.channelId).toBe("100");
			expect(added.source).toBe("cron");
			expect(Number.isNaN(Date.parse(added.nextRunAt ?? ""))).toBe(false);
			expect(added.runCount).toBe(0);
			expect(
				newCron(dir, h)
					.listJobs()
					.map((j) => j.id),
			).toContain(added.id);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("runJob boots the completion and delivers the reply to the job's channel", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-cron-"));
		try {
			const h = harness();
			const cron = newCron(dir, h);
			const result = await cron.runJob(job({ prompt: "nightly report" }));
			expect(result).toBe("ran");
			expect(h.calls).toEqual([{ sessionId: "sid", prompt: "nightly report" }]);
			expect(h.sends).toEqual([{ channelId: "100", text: "reply to: nightly report" }]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("delivers a failure notice when the completion errors", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-cron-"));
		try {
			const h = harness();
			h.completion = {
				async runCompletion() {
					return { reply: "", sessionId: "sid", error: "provider unreachable" };
				},
			};
			const cron = newCron(dir, h);
			const result = await cron.runJob(job());
			expect(result).toBe("ran");
			expect(h.sends[0]!.text).toContain("scheduled run failed");
			expect(h.sends[0]!.text).toContain("provider unreachable");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("skips a job without a channelId (never boots a run it cannot deliver)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-cron-"));
		try {
			const h = harness();
			const cron = newCron(dir, h);
			const result = await cron.runJob(job({ channelId: undefined }));
			expect(result).toBe("skipped");
			expect(h.calls).toEqual([]);
			expect(h.sends).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("skips a non-cron-sourced job sharing the store (heartbeat must not be hijacked)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-cron-"));
		try {
			const h = harness();
			const cron = newCron(dir, h);
			const hb = job({ source: "heartbeat" });
			expect(await cron.runJob(hb)).toBe("skipped");
			expect(h.calls).toEqual([]);
			expect(h.sends).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("removeJob cancels the job so it is no longer pending", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-cron-"));
		try {
			const h = harness();
			const cron = newCron(dir, h);
			const added = cron.addJob({ channelId: "100", scheduleText: "in 5m", prompt: "x" });
			const removed = cron.removeJob(added.id);
			expect(removed?.status).toBe("cancelled");
			expect(cron.listJobs().find((j) => j.id === added.id)?.status).toBe("cancelled");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("a job that comes due (via the scheduler seam) boots a turn and delivers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-cron-"));
		try {
			const h = harness();
			const cron = newCron(dir, h);
			const added = cron.addJob({ channelId: "42", scheduleText: "in 5m", prompt: "tick" });
			cron.start();
			const session = added.sessionId;
			// Advance the clock to the job's due time and sweep: the scheduled job is
			// claimed, run via the completion seam, and delivered to its channel.
			await cron.runDue(new Date(Date.parse(added.nextRunAt ?? "")));
			cron.stop();
			expect(h.calls).toEqual([{ sessionId: session, prompt: "tick" }]);
			expect(h.sends).toEqual([{ channelId: "42", text: "reply to: tick" }]);
			// Once-schedule completed: no further runs.
			const stored = cron.listJobs().find((j) => j.id === added.id);
			expect(stored?.status).toBe("completed");
			expect(stored?.runCount).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
