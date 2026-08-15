import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDashboard } from "../src/cli/dashboard-command.js";
import { AgentCronJobStore } from "../src/core/cron-jobs.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "axiom-cli-dash-"));
	tempDirs.push(dir);
	return dir;
}

function writeSession(dir: string, id: string, status?: { summary: string; taskState: "needs_input" | "completed" }) {
	const lines = [
		JSON.stringify({ type: "session", id, timestamp: "2026-08-15T09:00:00.000Z", cwd: dir }),
		JSON.stringify({
			type: "message",
			id: `m-${id}`,
			parentId: null,
			timestamp: "2026-08-15T09:01:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		}),
	];
	if (status) {
		lines.push(
			JSON.stringify({
				type: "agent_status",
				id: `a-${id}`,
				parentId: null,
				timestamp: "2026-08-15T09:01:00.000Z",
				status,
			}),
		);
	}
	writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

function homeWithData(): { dir: string; sessionsDir: string; cronStorePath: string; ledgerPath: string } {
	const dir = makeTempDir();
	const sessionsDir = join(dir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	writeSession(sessionsDir, "s-1", { summary: "Auditing the cron store", taskState: "needs_input" });
	const ledgerPath = join(dir, "ledger.json");
	writeFileSync(ledgerPath, JSON.stringify({ overrides: {} }));
	const cronStorePath = join(dir, "cron-jobs.json");
	const store = new AgentCronJobStore(cronStorePath);
	store.create({
		activeSessionId: "s-1",
		sessionId: "s-1",
		sessionFile: join(sessionsDir, "s-1.jsonl"),
		cwd: dir,
		source: "cron",
		channelId: "100",
		scheduleText: "in 1h",
		prompt: "channel work",
		now: new Date("2026-08-15T10:00:00.000Z"),
	});
	return { dir, sessionsDir, cronStorePath, ledgerPath };
}

describe("axiom dashboard", () => {
	it("prints the three-panel text report with live marks from the injected set", async () => {
		const home = homeWithData();
		const out: string[] = [];
		await runDashboard(false, {
			sessionsDir: home.sessionsDir,
			cronStorePath: home.cronStorePath,
			ledgerPath: home.ledgerPath,
			liveSessionIds: () => new Set(["s-1"]),
			now: new Date("2026-08-15T10:00:00.000Z"),
			write: (line) => out.push(line),
		});

		const text = out.join("\n");
		expect(text).toContain("sessions:");
		expect(text).toContain("spine:");
		expect(text).toContain("spend:");
		expect(text).toContain("Auditing the cron store");
		expect(text).toContain("needs input");
		expect(text).toContain("live");
		expect(text).toContain("in 1h");
	});

	it("prints the structured report with --json", async () => {
		const home = homeWithData();
		const out: string[] = [];
		await runDashboard(true, {
			sessionsDir: home.sessionsDir,
			cronStorePath: home.cronStorePath,
			ledgerPath: home.ledgerPath,
			liveSessionIds: () => new Set(["s-1"]),
			write: (line) => out.push(line),
		});

		const parsed = JSON.parse(out.join("\n")) as {
			sessions: { lines: Array<{ id: string; live: boolean; needsInput: boolean }> };
			spine: { lines: Array<{ id: string; scheduleText: string }> };
			spend: { costUsd: number };
		};
		expect(parsed.sessions.lines[0]).toMatchObject({ id: "s-1", live: true, needsInput: true });
		expect(parsed.spine.lines[0]).toMatchObject({ scheduleText: "in 1h" });
		expect(parsed.spend.costUsd).toBe(0);
	});

	it("renders without live marks when the probe fails (daemon down)", async () => {
		const home = homeWithData();
		const out: string[] = [];
		await runDashboard(false, {
			sessionsDir: home.sessionsDir,
			cronStorePath: home.cronStorePath,
			ledgerPath: home.ledgerPath,
			liveSessionIds: async () => {
				throw new Error("daemon unreachable");
			},
			write: (line) => out.push(line),
		});

		const text = out.join("\n");
		expect(text).toContain("sessions:");
		// The session still shows, just without the live flag.
		expect(text).toContain("needs input");
		expect(text).not.toContain("(live");
	});
});
