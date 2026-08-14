import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleCostCommand, newestSessionFile } from "../../src/cli/cost-command.js";
import { MemoryActiveProjectStore } from "../../src/gateway/active-project.js";
import { buildGatewayCostReport, costCommand } from "../../src/gateway/commands/cost.js";
import { sessionIdForChannel } from "../../src/gateway/completion.js";
import type { GatewayCommandContext } from "../../src/gateway/types.js";

/** Write a session file in the baseline's real JSONL format. */
function writeSessionFile(dir: string, name: string, options?: { usage?: boolean }): string {
	const header = {
		type: "session",
		version: 3,
		id: `019f-${name}`,
		timestamp: "2026-08-12T00:00:00.000Z",
		cwd: "/tmp/proj",
		rlmDepth: 0,
	};
	const assistant = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: "2026-08-12T00:00:01.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-v4-flash",
			responseModel: "deepseek-v4-flash",
			usage: {
				input: 100_000,
				output: 50_000,
				cacheRead: 10_000,
				cacheWrite: 1_000,
				totalTokens: 161_000,
				cost: {
					input: 0.028,
					output: 0.042,
					cacheRead: 0.0028,
					cacheWrite: 0.028,
					total: 0.00581,
				},
			},
			stopReason: "stop",
			timestamp: 1723404001000,
		},
	};
	const lines = [JSON.stringify(header)];
	if (options?.usage !== false) lines.push(JSON.stringify(assistant));
	const path = join(dir, name);
	writeFileSync(path, lines.join("\n") + "\n");
	return path;
}

async function home(): Promise<string> {
	return mkdtemp(join(tmpdir(), "axiom-cost-"));
}

describe("gateway /cost command", () => {
	it("shows the channel session cost, lifetime cost, cap, and model bucket", async () => {
		const dir = await home();
		try {
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			writeSessionFile(sessionsDir, `${sessionIdForChannel("+1")}.jsonl`);
			writeFileSync(join(dir, "ledger.json"), JSON.stringify({ maxRunCostUsd: 0.5, overrides: {} }));
			const ctx: GatewayCommandContext = {
				channelId: "+1",
				profile: "default",
				axiomHomeDir: dir,
				projectHome: dir,
				sessionsDir,
			};
			const report = buildGatewayCostReport(ctx);
			expect(report).toContain("session $");
			expect(report).toContain("lifetime $");
			expect(report).toContain("cap $0.5000");
			expect(report).toContain("deepseek/deepseek-v4-flash");
			// The handler path surfaces the same report.
			expect(costCommand.handler([], ctx)).toBe(report);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("says so when the channel has no recorded cost", async () => {
		const dir = await home();
		try {
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const ctx: GatewayCommandContext = {
				channelId: "+1",
				profile: "default",
				axiomHomeDir: dir,
				projectHome: dir,
				sessionsDir,
			};
			expect(buildGatewayCostReport(ctx)).toBe("no cost recorded for this channel yet");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("resolves the anchored session key channel:project:generation", async () => {
		const dir = await home();
		try {
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const projects = new MemoryActiveProjectStore();
			projects.set("+1", "web");
			writeSessionFile(sessionsDir, `${sessionIdForChannel("+1:web:0")}.jsonl`);
			writeFileSync(join(dir, "ledger.json"), JSON.stringify({ overrides: {} }));
			const ctx: GatewayCommandContext = {
				channelId: "+1",
				profile: "default",
				axiomHomeDir: dir,
				projectHome: dir,
				sessionsDir,
				activeProject: "web",
				activeProjects: projects,
			};
			const report = buildGatewayCostReport(ctx);
			expect(report).toContain("session $");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("counts archived sessions in the lifetime but not as the channel session", async () => {
		const dir = await home();
		try {
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			writeSessionFile(sessionsDir, `${sessionIdForChannel("+1")}.jsonl`);
			// Another channel's archived session adds to lifetime.
			const archived = writeSessionFile(sessionsDir, `${sessionIdForChannel("+9")}.jsonl.archived-1723405000000`);
			void archived;
			writeFileSync(join(dir, "ledger.json"), JSON.stringify({ overrides: {} }));
			const ctx: GatewayCommandContext = {
				channelId: "+1",
				profile: "default",
				axiomHomeDir: dir,
				projectHome: dir,
				sessionsDir,
			};
			const report = buildGatewayCostReport(ctx);
			expect(report).toContain("session $");
			expect(report).toContain("lifetime $");
			// Lifetime > session because the archived channel adds spend.
			const sessionMatch = report.match(/session (\$[\d.]+)/);
			const lifetimeMatch = report.match(/lifetime (\$[\d.]+)/);
			expect(sessionMatch).not.toBeNull();
			expect(lifetimeMatch).not.toBeNull();
			expect(Number(lifetimeMatch![1]!.slice(1))).toBeGreaterThan(Number(sessionMatch![1]!.slice(1)));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("axiom cost CLI", () => {
	it("reports on an explicit session path", async () => {
		const dir = await home();
		try {
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const path = writeSessionFile(sessionsDir, "cli-session.jsonl");
			writeFileSync(join(dir, "ledger.json"), JSON.stringify({ overrides: {} }));
			const out: string[] = [];
			const owned = await handleCostCommand(["cost", path], {
				sessionsDir,
				ledgerPath: join(dir, "ledger.json"),
				write: (l) => out.push(l),
			});
			expect(owned).toBe(true);
			expect(out.join("\n")).toContain("session $");
			expect(out.join("\n")).toContain("deepseek/deepseek-v4-flash");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("defaults to the newest session and prefers live files over archives", async () => {
		const dir = await home();
		try {
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			writeSessionFile(sessionsDir, "old.jsonl.archived-1723405000000");
			writeSessionFile(sessionsDir, "newer.jsonl");
			expect(newestSessionFile(sessionsDir)).toMatch(/newer\.jsonl$/);
			const out: string[] = [];
			await handleCostCommand(["cost"], {
				sessionsDir,
				ledgerPath: join(dir, "ledger.json"),
				write: (l) => out.push(l),
			});
			expect(out.join("\n")).toContain("session $");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("handles a missing file honestly and ignores non-cost commands", async () => {
		const dir = await home();
		try {
			const out: string[] = [];
			await handleCostCommand(["cost", join(dir, "nope.jsonl")], {
				sessionsDir: join(dir, "sessions"),
				write: (l) => out.push(l),
			});
			expect(out.join("\n")).toContain("no such session file");
			const owned = await handleCostCommand(["peers", "list"], { write: () => {} });
			expect(owned).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
