import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCronJobStore } from "../src/core/cron-jobs.js";
import { buildDashboardReport, renderDashboardText } from "../src/core/dashboard.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "axiom-dashboard-"));
	tempDirs.push(dir);
	return dir;
}

/** Write a minimal session jsonl the scanner understands. */
function writeSessionFile(
	sessionsDir: string,
	file: string,
	header: { id: string; timestamp: string; cwd: string },
	lines: Array<Record<string, unknown>>,
): void {
	const sessionLine = { type: "session", ...header };
	const body = [JSON.stringify(sessionLine), ...lines.map((line) => JSON.stringify(line))].join("\n");
	writeFileSync(join(sessionsDir, file), `${body}\n`);
}

function agentStatusEntry(
	summary: string,
	taskState?: "needs_input" | "completed",
	timestamp = "2026-08-15T10:00:00.000Z",
) {
	return {
		type: "agent_status",
		id: `status-${Math.random().toString(36).slice(2)}`,
		parentId: null,
		timestamp,
		status: { summary, taskState },
	};
}

function userMessageEntry(timestamp: string) {
	return {
		type: "message",
		id: `msg-${Math.random().toString(36).slice(2)}`,
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "hello" }] },
	};
}

/** A priced assistant message entry, the shape the cost ledger reads. */
function assistantUsageEntry(timestamp: string, provider: string, model: string, costUsd: number) {
	return {
		type: "message",
		id: `msg-${Math.random().toString(36).slice(2)}`,
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: costUsd / 2, output: costUsd / 2, cacheRead: 0, cacheWrite: 0, total: costUsd },
			},
			provider,
			model,
		},
	};
}

describe("buildDashboardReport sessions panel", () => {
	it("keeps live and needs-input sessions, caps the recent rest at five, and reads persisted recaps", async () => {
		const dir = makeTempDir();
		const sessionsDir = join(dir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		// Two live sessions: one needs input, one clean.
		writeSessionFile(
			sessionsDir,
			"s-live-needs.jsonl",
			{ id: "s-live-needs", timestamp: "2026-08-15T09:00:00.000Z", cwd: "/tmp" },
			[userMessageEntry("2026-08-15T09:01:00.000Z"), agentStatusEntry("Auditing the cron store", "needs_input")],
		);
		writeSessionFile(
			sessionsDir,
			"s-live-clean.jsonl",
			{ id: "s-live-clean", timestamp: "2026-08-15T09:00:00.000Z", cwd: "/tmp" },
			[userMessageEntry("2026-08-15T09:02:00.000Z"), agentStatusEntry("Watching for messages", "completed")],
		);
		// Six recent non-live sessions with distinct activity times.
		for (let i = 0; i < 6; i++) {
			const id = `s-recent-${i}`;
			const activity = `2026-08-15T08:${(50 - i).toString().padStart(2, "0")}:00.000Z`;
			writeSessionFile(sessionsDir, `${id}.jsonl`, { id, timestamp: "2026-08-15T08:00:00.000Z", cwd: "/tmp" }, [
				userMessageEntry(activity),
				agentStatusEntry(`Recent task ${i}`, "completed"),
			]);
		}

		const report = buildDashboardReport({
			sessionsDir,
			liveSessionIds: new Set(["s-live-needs", "s-live-clean"]),
		});

		expect(report.sessions.unavailable).toBeUndefined();
		// Live first, then the five most recent of the rest; the oldest recent is cut.
		expect(report.sessions.lines.map((line) => line.id)).toEqual([
			"s-live-clean",
			"s-live-needs",
			"s-recent-0",
			"s-recent-1",
			"s-recent-2",
			"s-recent-3",
			"s-recent-4",
		]);
		expect(report.sessions.lines[0]).toMatchObject({ live: true, needsInput: false });
		expect(report.sessions.lines[1]).toMatchObject({
			live: true,
			needsInput: true,
			recap: "Auditing the cron store",
		});
	});

	it("needs-input sessions always survive the cap even when they are not recent", async () => {
		const dir = makeTempDir();
		const sessionsDir = join(dir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		writeSessionFile(
			sessionsDir,
			"s-stuck.jsonl",
			{ id: "s-stuck", timestamp: "2026-08-15T01:00:00.000Z", cwd: "/tmp" },
			[userMessageEntry("2026-08-15T01:01:00.000Z"), agentStatusEntry("Blocked on a question", "needs_input")],
		);
		for (let i = 0; i < 8; i++) {
			const id = `s-busy-${i}`;
			writeSessionFile(sessionsDir, `${id}.jsonl`, { id, timestamp: "2026-08-15T09:00:00.000Z", cwd: "/tmp" }, [
				userMessageEntry(`2026-08-15T09:${(30 - i).toString().padStart(2, "0")}:00.000Z`),
				agentStatusEntry(`Busy ${i}`, "completed"),
			]);
		}

		const report = buildDashboardReport({ sessionsDir });

		const ids = report.sessions.lines.map((line) => line.id);
		expect(ids).toContain("s-stuck");
		expect(ids.length).toBe(6); // the stuck session plus five recent
		expect(report.sessions.lines.find((line) => line.id === "s-stuck")).toMatchObject({ needsInput: true });
	});

	it("degrades with a one-line notice when the sessions directory is missing", async () => {
		const report = buildDashboardReport({});
		expect(report.sessions.lines).toEqual([]);
		expect(report.sessions.unavailable).toContain("sessions");
	});
});

describe("buildDashboardReport spine panel", () => {
	it("shows every active and paused job with next run and paused flag, excluding completed and cancelled", async () => {
		const dir = makeTempDir();
		const storePath = join(dir, "cron-jobs.json");
		const store = new AgentCronJobStore(storePath);
		const cancelled = store.create({
			activeSessionId: "sess-1",
			sessionId: "sess-1",
			sessionFile: "/tmp/s.jsonl",
			cwd: "/tmp",
			source: "cron",
			channelId: "42",
			scheduleText: "in 1h",
			prompt: "gateway work",
			now: new Date("2026-08-15T00:00:00.000Z"),
		});
		const heartbeat = store.createHeartbeat({
			activeSessionId: "sess-1",
			sessionId: "sess-1",
			sessionFile: "/tmp/s.jsonl",
			cwd: "/tmp",
			scheduleText: "every 5m",
			prompt: "check",
			now: new Date("2026-08-15T00:00:00.000Z"),
		});
		store.pauseHeartbeat(heartbeat.activeSessionId);
		store.cancel(cancelled.id);
		const live = store.create({
			activeSessionId: "sess-1",
			sessionId: "sess-1",
			sessionFile: "/tmp/s.jsonl",
			cwd: "/tmp",
			source: "cron",
			channelId: "100",
			scheduleText: "in 2h",
			prompt: "channel work",
			now: new Date("2026-08-15T00:00:00.000Z"),
		});

		const report = buildDashboardReport({ cronStorePath: storePath });

		expect(report.spine.unavailable).toBeUndefined();
		// The paused heartbeat and the live gateway job are shown; the cancelled one is not.
		const ids = report.spine.lines.map((line) => line.id);
		expect(ids).toContain(heartbeat.id);
		expect(ids).toContain(live.id);
		expect(ids).not.toContain(cancelled.id);
		const pausedLine = report.spine.lines.find((line) => line.id === heartbeat.id);
		expect(pausedLine).toMatchObject({ paused: true, kind: "interval" });
		expect(pausedLine?.nextRunAt).toBeUndefined();
		const liveLine = report.spine.lines.find((line) => line.id === live.id);
		expect(liveLine).toMatchObject({ paused: false, scheduleText: "in 2h" });
	});

	it("degrades with a one-line notice when no cron store is configured, and renders empty cleanly", async () => {
		const missing = buildDashboardReport({});
		expect(missing.spine.lines).toEqual([]);
		expect(missing.spine.unavailable).toContain("cron");

		const dir = makeTempDir();
		const report = buildDashboardReport({ cronStorePath: join(dir, "cron-jobs.json") });
		expect(report.spine.unavailable).toBeUndefined();
		expect(report.spine.lines).toEqual([]);
	});
});

describe("buildDashboardReport spend panel", () => {
	it("prices the whole-profile lifetime from recorded entries only", async () => {
		const dir = makeTempDir();
		const sessionsDir = join(dir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		writeSessionFile(sessionsDir, "s-a.jsonl", { id: "s-a", timestamp: "2026-08-15T00:00:00.000Z", cwd: "/tmp" }, [
			assistantUsageEntry("2026-08-15T00:01:00.000Z", "provider-a", "model-a", 0.5),
		]);
		writeSessionFile(sessionsDir, "s-b.jsonl", { id: "s-b", timestamp: "2026-08-15T00:00:00.000Z", cwd: "/tmp" }, [
			assistantUsageEntry("2026-08-15T00:02:00.000Z", "provider-a", "model-a", 0.25),
		]);
		writeFileSync(join(dir, "ledger.json"), JSON.stringify({ overrides: {} }));

		const report = buildDashboardReport({ sessionsDir, ledgerPath: join(dir, "ledger.json") });

		expect(report.spend.unavailable).toBeUndefined();
		expect(report.spend.costUsd).toBeCloseTo(0.75, 5);
	});

	it("degrades with a one-line notice when no sessions directory is configured", async () => {
		const report = buildDashboardReport({ ledgerPath: join(makeTempDir(), "ledger.json") });
		expect(report.spend.costUsd).toBe(0);
		expect(report.spend.unavailable).toContain("spend");
	});
});

describe("renderDashboardText", () => {
	it("renders the three panels with needs-input, paused, and relative next-run markers", () => {
		const now = new Date("2026-08-15T12:00:00.000Z");
		const report = {
			sessions: {
				lines: [
					{
						id: "s-1",
						modified: "2026-08-15T11:00:00.000Z",
						recap: "Auditing the cron store",
						needsInput: true,
						live: true,
					},
				],
			},
			spine: {
				lines: [
					{
						id: "j-1",
						kind: "interval" as const,
						scheduleText: "every 5m",
						nextRunAt: "2026-08-15T12:04:00.000Z",
						paused: false,
					},
					{ id: "j-2", kind: "once" as const, scheduleText: "in 1h", paused: true },
				],
			},
			spend: { costUsd: 1.25 },
		};

		const text = renderDashboardText(report, now);

		expect(text).toContain("sessions");
		expect(text).toContain("spine");
		expect(text).toContain("spend");
		expect(text).toContain("s-1");
		expect(text).toContain("Auditing the cron store");
		expect(text).toContain("needs input");
		expect(text).toContain("live");
		expect(text).toContain("in ~4m");
		expect(text).toContain("paused");
		expect(text).toContain("$1.25");
	});

	it("renders one-line notices for unavailable panels and empty states", () => {
		const report = {
			sessions: { lines: [], unavailable: "sessions: no sessions directory" },
			spine: { lines: [] },
			spend: { costUsd: 0 },
		};

		const text = renderDashboardText(report, new Date("2026-08-15T12:00:00.000Z"));

		expect(text).toContain("sessions: no sessions directory");
		expect(text).toContain("no scheduled jobs");
		expect(text).toContain("no recorded spend yet");
	});
});
