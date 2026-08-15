import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentCronJobStore } from "../../src/core/cron-jobs.js";
import { InMemoryActiveModelStore } from "../../src/gateway/active-model.js";
import { MemoryActiveProjectStore } from "../../src/gateway/active-project.js";
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
	it("advertises /model in /help and shows the active override when set", () => {
		const store = new InMemoryActiveModelStore();
		const c = { ...ctx("/tmp"), modelStore: store };
		expect(dispatchCommand("/help", c)).toContain("/model");
		store.save({ provider: "deepseek", model: "deepseek-v4-pro" });
		expect(dispatchCommand("/help", c)).toContain("active model: deepseek/deepseek-v4-pro");
		store.clear();
		expect(dispatchCommand("/help", c)).toContain("no model override set");
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

describe("dashboard command", () => {
	it("advertises /dashboard in /help", () => {
		expect(dispatchCommand("/help", ctx("/tmp"))).toContain("/dashboard");
	});
	it("renders the three-panel report from the shared home", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-dash-"));
		try {
			const sessionsDir = join(dir, "sessions");
			await mkdir(sessionsDir, { recursive: true });
			await writeFile(
				join(sessionsDir, "s-1.jsonl"),
				[
					JSON.stringify({ type: "session", id: "s-1", timestamp: "2026-08-15T09:00:00.000Z", cwd: dir }),
					JSON.stringify({
						type: "message",
						id: "m1",
						parentId: null,
						timestamp: "2026-08-15T09:01:00.000Z",
						message: { role: "user", content: [{ type: "text", text: "hello" }] },
					}),
					JSON.stringify({
						type: "agent_status",
						id: "a1",
						parentId: null,
						timestamp: "2026-08-15T09:01:00.000Z",
						status: { summary: "Auditing the cron store", taskState: "needs_input" },
					}),
				].join("\n"),
			);
			// A priced assistant entry so the spend panel has recorded spend.
			await writeFile(
				join(sessionsDir, "s-2.jsonl"),
				[
					JSON.stringify({ type: "session", id: "s-2", timestamp: "2026-08-15T09:00:00.000Z", cwd: dir }),
					JSON.stringify({
						type: "message",
						id: "m2",
						parentId: null,
						timestamp: "2026-08-15T09:02:00.000Z",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							usage: {
								input: 100,
								output: 50,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 150,
								cost: { input: 0.25, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 0.5 },
							},
							provider: "provider-a",
							model: "model-a",
						},
					}),
				].join("\n"),
			);
			await writeFile(join(dir, "ledger.json"), JSON.stringify({ overrides: {} }));
			const cronStore = new AgentCronJobStore(join(dir, "cron-jobs.json"));
			cronStore.create({
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

			const c: GatewayCommandContext = {
				...ctx(dir),
				sessionsDir,
				liveSessionIds: new Set(["s-1"]),
			};
			const out = dispatchCommand("/dashboard", c);

			expect(out).toContain("sessions:");
			expect(out).toContain("spine:");
			expect(out).toContain("spend:");
			expect(out).toContain("s-1");
			expect(out).toContain("Auditing the cron store");
			expect(out).toContain("needs input");
			expect(out).toContain("live");
			expect(out).toContain("in 1h");
			expect(out).toContain("$0.50");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("degrades per panel with one-line notices when nothing is configured", () => {
		const out = dispatchCommand("/dashboard", ctx("/tmp"));
		expect(out).toContain("sessions: no sessions directory configured");
		expect(out).toContain("no scheduled jobs");
		expect(out).toContain("spend: no sessions directory configured");
	});
	it("explains usage on extra arguments", () => {
		expect(dispatchCommand("/dashboard extra", ctx("/tmp"))).toContain("usage: /dashboard");
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

	it("list shows only gateway cron jobs, hiding heartbeats sharing the store", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-croncmd-"));
		try {
			const c = cronCtx(dir);
			dispatchCommand("/cron add every 5m weekly cost summary", c);
			// A heartbeat in the SAME store file must not render as a /cron job.
			new AgentCronJobStore(join(dir, "cron-jobs.json")).createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: join(dir, "session.jsonl"),
				cwd: dir,
				scheduleText: "every 5m",
				prompt: "check on the session",
			});
			const listed = dispatchCommand("/cron list", c);
			expect(listed).toContain("weekly cost summary");
			expect(listed).not.toContain("check on the session");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rm resolves only gateway cron jobs and cannot cancel a heartbeat", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-croncmd-"));
		try {
			const c = cronCtx(dir);
			const heartbeat = new AgentCronJobStore(join(dir, "cron-jobs.json")).createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: join(dir, "session.jsonl"),
				cwd: dir,
				scheduleText: "every 5m",
				prompt: "check on the session",
			});
			expect(dispatchCommand(`/cron rm ${heartbeat.id}`, c)).toContain("no cron job matching");
			expect(
				new AgentCronJobStore(join(dir, "cron-jobs.json")).list().find((j) => j.id === heartbeat.id),
			).toMatchObject({ status: "active" });
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

describe("projects menu + live switching", () => {
	it("renders a menu with the active project marked", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-menu-"));
		try {
			dispatchCommand("/projects add alpha", ctx(dir));
			dispatchCommand("/projects add beta", ctx(dir));
			const store = new MemoryActiveProjectStore();
			store.set("+1", "alpha");
			const c = { ...ctx(dir), channelId: "+1", activeProject: "alpha", activeProjects: store };
			const out = dispatchCommand("/projects", c);
			expect(out).toContain("active: alpha");
			expect(out).toContain("alpha");
			expect(out).toContain("beta");
			expect(out).toContain("/projects use");
			expect(out).toContain("/projects rm");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("shows active: none when no channel context (dispatch without a channel)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-menu-"));
		try {
			dispatchCommand("/projects add alpha", ctx(dir));
			expect(dispatchCommand("/projects", ctx(dir))).toContain("active: none");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("use switches the chat's active project and persists it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-use-"));
		try {
			dispatchCommand("/projects add alpha", ctx(dir));
			const store = new MemoryActiveProjectStore();
			const c = { ...ctx(dir), channelId: "+1", activeProjects: store };
			const out = dispatchCommand("/projects use alpha", c);
			expect(out).toContain("anchored");
			expect(store.get("+1")).toBe("alpha");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("use rejects unknown projects, invalid names, and channel-less dispatches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-use-"));
		try {
			dispatchCommand("/projects add alpha", ctx(dir));
			const store = new MemoryActiveProjectStore();
			const c = { ...ctx(dir), channelId: "+1", activeProjects: store };
			expect(dispatchCommand("/projects use nope", c)).toContain("no project");
			expect(dispatchCommand("/projects use Bad_Name", c)).toContain("invalid");
			expect(dispatchCommand("/projects use alpha", ctx(dir))).toContain("usage");
			expect(store.get("+1")).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rm clears active mappings across channels, bumps generation, and drops sessions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-rm-"));
		try {
			dispatchCommand("/projects add alpha", ctx(dir));
			const store = new MemoryActiveProjectStore();
			store.set("+1", "alpha");
			store.set("+2", "alpha");
			const dropped: string[] = [];
			const c = {
				...ctx(dir),
				channelId: "+1",
				activeProject: "alpha",
				activeProjects: store,
				dropProjectSessions: (p: string) => dropped.push(p),
			};
			const out = dispatchCommand("/projects rm alpha", c);
			expect(out).toContain("removed");
			expect(store.get("+1")).toBeUndefined();
			expect(store.get("+2")).toBeUndefined();
			expect(store.generation("alpha")).toBe(1);
			expect(dropped).toEqual(["alpha"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rm rejects traversal and outside-root names", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-rm-"));
		try {
			expect(dispatchCommand("/projects rm ..", ctx(dir))).toContain("invalid");
			expect(dispatchCommand("/projects rm /etc/passwd", ctx(dir))).toContain("invalid");
			expect(dispatchCommand("/projects rm a/b", ctx(dir))).toContain("invalid");
			expect(dispatchCommand("/projects rm alpha", ctx(dir))).toContain("no project");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("help advertises live project switching", () => {
	it("/help lists /projects use", () => {
		expect(dispatchCommand("/help", ctx("/tmp"))).toContain("/projects use");
	});
});
