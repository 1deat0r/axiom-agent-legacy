import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchCommand } from "../../src/gateway/commands/index.js";
import { defaultGatewayConfig, isAllowedSender } from "../../src/gateway/config.js";

function ctx(axiomHomeDir: string, profile = "default"): GatewayCommandContext {
	// Mirror production: the default profile's home IS the axiom root.
	const projectHome = profile === "default" ? axiomHomeDir : join(axiomHomeDir, "profiles", profile);
	return { profile, axiomHomeDir, projectHome };
}

describe("command dispatch", () => {
	it("answers /help", () => {
		const out = dispatchCommand("/help", ctx("/tmp"));
		expect(out).toContain("/profiles");
		expect(out).toContain("/soul");
	});
	it("rejects an unknown command with a usage hint", () => {
		expect(dispatchCommand("/bogus x", ctx("/tmp"))).toContain("unknown command");
	});
});

describe("profiles command", () => {
	it("lists, creates, and switches profiles against a real home", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-pm-"));
		try {
			expect(dispatchCommand("/profiles", ctx(dir))).toContain("no profiles");
			expect(dispatchCommand("/profiles create builder", ctx(dir))).toContain("created");
			expect(dispatchCommand("/profiles", ctx(dir))).toContain("builder");
			expect(dispatchCommand("/profiles switch builder", ctx(dir))).toContain(
				"restart `axiom gateway --profile builder`",
			);
			expect(dispatchCommand("/profiles switch nope", ctx(dir))).toContain("unknown profile");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("projects command", () => {
	it("adds, lists, removes projects on the active profile", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-pm-"));
		try {
			dispatchCommand("/profiles create w", ctx(dir));
			const c = ctx(dir, "w");
			expect(dispatchCommand("/projects add alpha", c)).toContain("added");
			expect(dispatchCommand("/projects", c)).toContain("alpha");
			expect(dispatchCommand("/projects rm alpha", c)).toContain("removed");
			expect(dispatchCommand("/projects", c)).toContain("no projects");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("soul command", () => {
	it("sets and views a profile's SOUL.md", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-pm-"));
		try {
			dispatchCommand("/profiles create p", ctx(dir));
			expect(dispatchCommand("/soul p I am the PM builder.", ctx(dir))).toContain("updated");
			expect(dispatchCommand("/soul p", ctx(dir))).toContain("PM builder");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("allowlist (owner gate)", () => {
	it("isAllowedSender gates on the senders list", () => {
		const cfg = { senders: ["+1"] };
		expect(isAllowedSender(cfg, "+1")).toBe(true);
		expect(isAllowedSender(cfg, "+2")).toBe(false);
		expect(isAllowedSender(defaultGatewayConfig(), "+1")).toBe(false);
	});
});

import { GatewayCron } from "../../src/gateway/cron.js";
import type { CompletionRunner, GatewayCommandContext, GatewayTransport } from "../../src/gateway/types.js";

/** A real GatewayCron over a tmp dir, wired into a command context. */
function cronCtx(dir: string, channelId = "100"): GatewayCommandContext {
	const completion: CompletionRunner = {
		async runCompletion() {
			return { reply: "ok", sessionId: "s" };
		},
	};
	const transport: GatewayTransport = {
		async connect() {},
		async disconnect() {},
		async send() {},
		onMessage() {},
	};
	const cron = new GatewayCron({
		storePath: join(dir, "cron-jobs.json"),
		completion,
		transport,
		profile: "default",
		projectHome: dir,
	});
	const base = ctx(dir);
	return { ...base, cron, channelId };
}

describe("cron command", () => {
	it("advertises /cron in /help", () => {
		expect(dispatchCommand("/help", ctx("/tmp"))).toContain("/cron");
	});
	it("explains usage with no subcommand", () => {
		expect(dispatchCommand("/cron", ctx("/tmp"))).toContain("usage:");
	});
	it("adds and lists a scheduled job on the channel", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-croncmd-"));
		try {
			const c = cronCtx(dir);
			expect(dispatchCommand("/cron add every 5m weekly cost summary", c)).toContain("scheduled");
			const listed = dispatchCommand("/cron list", c);
			expect(listed).toContain("weekly cost summary");
			expect(listed).toContain("every 5m");
			// The schedule prefix is split from the prompt: prompt is the rest.
			const stored = c.cron!.listJobs()[0]!;
			expect(stored.schedule.expression).toBe("every 5m");
			expect(stored.prompt).toBe("weekly cost summary");
			expect(stored.channelId).toBe("100");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("creates a one-shot 'in' job and cancels it by prefix id", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-croncmd-"));
		try {
			const c = cronCtx(dir);
			dispatchCommand("/cron add in 5m ping", c);
			const id = c.cron!.listJobs()[0]!.id;
			expect(dispatchCommand(`/cron rm ${id.slice(0, 8)}`, c)).toContain("cancelled");
			expect(dispatchCommand("/cron list", c)).toContain("no scheduled cron jobs");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("reports a bad schedule clearly", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-croncmd-"));
		try {
			const c = cronCtx(dir);
			expect(dispatchCommand("/cron add nope ping", c)).toContain("could not schedule");
			expect(dispatchCommand("/cron rm nope", c)).toContain("no cron job matching");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("refuses an ambiguous rm prefix and asks for a longer id", () => {
		// Two jobs sharing the first 8 chars of their id -> the prefix is ambiguous.
		const c = ctx("/tmp");
		c.cron = {
			listJobs() {
				return [jobWithId("aaaaaaaa1111"), jobWithId("aaaaaaaa2222")];
			},
			addJob() {
				throw new Error("unused");
			},
			removeJob() {
				return undefined;
			},
		};
		expect(dispatchCommand("/cron rm aaaaaaaa", c)).toContain("matches 2 jobs");
	});
	it("parses the other advertised schedule forms into the right split", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-croncmd-"));
		try {
			const c = cronCtx(dir);
			dispatchCommand("/cron add @hourly ping", c);
			dispatchCommand("/cron add 0 3 * * * daily digest", c);
			const bySchedule = Object.fromEntries(c.cron!.listJobs().map((j) => [j.schedule.expression, j]));
			expect(bySchedule["0 * * * *"]?.prompt).toBe("ping");
			expect(bySchedule["0 3 * * *"]?.prompt).toBe("daily digest");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports when cron is not wired on the gateway", () => {
		expect(dispatchCommand("/cron list", ctx("/tmp"))).toContain("not wired");
		expect(dispatchCommand("/cron add every 5m x", ctx("/tmp"))).toContain("not wired");
	});
});

/** Minimal job for fake-cron ambiguity tests. */
function jobWithId(id: string): import("../../src/core/cron-jobs.js").AgentCronJob {
	return {
		id,
		status: "active",
		source: "cron",
		channelId: "100",
		activeSessionId: "s",
		sessionId: "s",
		sessionFile: "/tmp/s.jsonl",
		cwd: "/tmp",
		prompt: "p",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		runCount: 0,
	};
}
