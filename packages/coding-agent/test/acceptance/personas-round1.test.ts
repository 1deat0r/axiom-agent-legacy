/**
 * Round-1 synthetic-user acceptance: five unique personas, each driving the
 * shipped axiom surface (profiles + ledger + cap + memory) through the REAL
 * extension defaults — real fs, real env plumbing, real file layout.
 * Each journey records an experience log (the basis for the persona reviews
 * in docs/acceptance/round1.md).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import { handleProfileCommand } from "../../src/cli/profile-command.js";
import {
	AXIOM_HOME_ENV,
	assistantMessage,
	bootAxiom,
	cleanupHome,
	emitEvent,
	tempHome,
	turnEnd,
	turnStart,
	usage,
	userCtx,
} from "./helpers.js";

function assistantEntry(u: ReturnType<typeof usage>, provider = "deepseek", model = "deepseek-chat") {
	return {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: "2026-08-11T00:00:00.000Z",
		message: assistantMessage({ provider, model, usage: u }),
	};
}

describe("round-1 synthetic users", () => {
	it("Mira (solo indie dev): client profile end to end", async () => {
		const home = await tempHome();
		const log: string[] = [];
		try {
			vi.stubEnv(AXIOM_HOME_ENV, home);
			// 1. create the client profile
			expect(await handleProfileCommand(["profile", "create", "client-alpha"])).toBe(true);
			const profileHome = join(home, "profiles", "client-alpha");
			log.push("created profile client-alpha");
			// 2. boot the axiom surface into the profile home
			vi.stubEnv(AXIOM_HOME_ENV, profileHome);
			vi.stubEnv("PI_CODING_AGENT_DIR", profileHome);
			const pi = bootAxiom(profileHome);
			const { ctx, notified, aborted } = userCtx();
			// 3. SOUL.md rides the system prompt
			const soul = fromAny<
				{
					systemPrompt?: string;
				},
				unknown
			>(
				await emitEvent(
					pi,
					"before_agent_start",
					{ type: "before_agent_start", prompt: "hello", systemPrompt: "base" },
					ctx,
				),
			);
			expect(soul.systemPrompt).toContain("client-alpha");
			log.push("SOUL.md injected into the system prompt");
			// 4. /cost on a fresh session
			await pi.commands.get("cost")!.handler("", fromAny<never, unknown>(ctx));
			expect(notified[0]).toContain("session $0.0000");
			log.push(`ran /cost -> "${notified[0]}"`);
			// 5. persist a durable fact with the memory tool
			const tool = pi.tools.find((t) => t.name === "memory")!;
			const added = fromPartial<{
				content: Array<{ type: string; text: string }>;
			}>(
				await tool.execute("c1", {
					action: "add",
					content: "Client Alpha wants weekly summaries",
					scope: "user",
				}),
			);
			expect(added.content[0]!.text).toContain("Remembered");
			log.push("memory tool persisted a durable fact");
			// 6. memory rides the prompt on the next run
			const withMemory = fromAny<
				{
					systemPrompt?: string;
				},
				unknown
			>(
				await emitEvent(
					pi,
					"before_agent_start",
					{ type: "before_agent_start", prompt: "hello", systemPrompt: "base" },
					ctx,
				),
			);
			expect(withMemory.systemPrompt).toContain("weekly summaries");
			log.push("memory fact rides the next run's prompt");
			// 7. set a run cap and hit it mid-run (the hard guard)
			await writeFile(join(profileHome, "ledger.json"), JSON.stringify({ maxRunCostUsd: 0.5 }));
			await emitEvent(pi, "agent_start", null, ctx);
			await emitEvent(
				pi,
				"turn_end",
				turnEnd(
					assistantMessage({
						provider: "deepseek",
						model: "deepseek-chat",
						usage: usage({
							input: 600_000,
							cost: { input: 0.6, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.6 },
						}),
					}),
				),
				ctx,
			);
			await emitEvent(pi, "turn_start", turnStart(1), ctx);
			expect(aborted).toEqual(["abort"]);
			expect(notified.at(-1)).toContain("cost cap");
			log.push(`cap hit -> "${notified.at(-1)}"`);
			// 8. /cost shows the recorded spend (the run's message is in the session)
			const { ctx: ctx3, notified: n3 } = userCtx([
				assistantEntry(
					usage({ input: 600_000, cost: { input: 0.6, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.6 } }),
				),
			]);
			await pi.commands.get("cost")!.handler("", fromAny<never, unknown>(ctx3));
			expect(n3.at(-1)).toContain("session $0.6000");
			log.push(`ran /cost after the run -> "${n3.at(-1)}"`);
			// 9. the footer status tracks session cost (the session holds the run's message)
			const { ctx: ctx4, statuses } = userCtx([
				assistantEntry(
					usage({ input: 600_000, cost: { input: 0.6, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.6 } }),
				),
			]);
			await emitEvent(pi, "agent_end", null, ctx4);
			expect(statuses).toContainEqual(["axiom.cost", "$0.6000"]);
			log.push("footer status shows live session cost");
		} finally {
			vi.unstubAllEnvs();
			await cleanupHome(home);
		}
		expect(log).toHaveLength(8);
	});

	it("Tom (curious beginner): first agent, guided by empty states", async () => {
		const home = await tempHome();
		const log: string[] = [];
		try {
			vi.stubEnv(AXIOM_HOME_ENV, home);
			// 1. profile list on an empty home is a friendly empty state
			const out: string[] = [];
			await handleProfileCommand(["profile", "list"], { axiomHome: home, stdout: (s) => out.push(s) });
			expect(out.join(" ")).toContain("No profiles yet");
			log.push("profile list -> 'No profiles yet — create one…'");
			// 2. create a profile
			await handleProfileCommand(["profile", "create", "my-bot"], { axiomHome: home });
			log.push("created profile my-bot");
			// 3. boot; the starter SOUL.md is readable and gives the identity
			const profileHome = join(home, "profiles", "my-bot");
			vi.stubEnv(AXIOM_HOME_ENV, profileHome);
			vi.stubEnv("PI_CODING_AGENT_DIR", profileHome);
			const pi = bootAxiom(profileHome);
			const { ctx } = userCtx();
			const soul = fromAny<
				{
					systemPrompt?: string;
				},
				unknown
			>(
				await emitEvent(
					pi,
					"before_agent_start",
					{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
					ctx,
				),
			);
			expect(soul.systemPrompt).toContain("my-bot");
			expect(soul.systemPrompt).toContain("<<<profile>>>");
			log.push("system prompt carries the profile identity block");
			// 4. the memory block is delimited and human-readable
			const tool = pi.tools.find((t) => t.name === "memory")!;
			await tool.execute("c1", { action: "add", content: "Tom prefers plain English", scope: "user" });
			const mem = fromAny<
				{
					systemPrompt?: string;
				},
				unknown
			>(
				await emitEvent(
					pi,
					"before_agent_start",
					{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
					ctx,
				),
			);
			expect(mem.systemPrompt).toContain("<<<memory>>>");
			expect(mem.systemPrompt).toContain("- [user] Tom prefers plain English");
			log.push("memory block readable in the prompt");
			// 5. a zero cap disables LLM calls with an explicit notice
			await writeFile(join(profileHome, "ledger.json"), JSON.stringify({ maxRunCostUsd: 0 }));
			const { ctx: ctx2, aborted, notified } = userCtx();
			await emitEvent(pi, "agent_start", null, ctx2);
			await emitEvent(pi, "turn_start", turnStart(0), ctx2);
			expect(aborted).toEqual(["abort"]);
			expect(notified[0]).toContain("LLM calls disabled");
			log.push(`zero cap -> "${notified[0]}"`);
		} finally {
			vi.unstubAllEnvs();
			await cleanupHome(home);
		}
		expect(log).toHaveLength(5);
	});

	it("Priya (budget-watcher): cost control with overrides", async () => {
		const home = await tempHome();
		const log: string[] = [];
		try {
			const profileHome = join(home, "profiles", "analytics");
			await mkdir(join(profileHome, "profiles"), { recursive: true });
			vi.stubEnv(AXIOM_HOME_ENV, profileHome);
			vi.stubEnv("PI_CODING_AGENT_DIR", profileHome);
			const pi = bootAxiom(profileHome);
			const { ctx } = userCtx();
			// 1. Priya prices her model with an override (entry rates beat catalog)
			await writeFile(
				join(profileHome, "ledger.json"),
				JSON.stringify({
					overrides: { "deepseek/deepseek-chat": { input: 0.5, output: 1.0, cacheRead: 0.05, cacheWrite: 0.5 } },
				}),
			);
			// 2. a run recorded at catalog price is reported at override price
			await emitEvent(pi, "agent_start", null, ctx);
			await emitEvent(
				pi,
				"turn_end",
				turnEnd(
					assistantMessage({
						provider: "deepseek",
						model: "deepseek-chat",
						usage: usage({
							input: 1_000_000,
							cost: { input: 9.0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9.0 },
						}),
					}),
				),
				ctx,
			);
			const settled = userCtx([
				assistantEntry(
					usage({ input: 1_000_000, cost: { input: 9.0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9.0 } }),
				),
			]);
			await emitEvent(pi, "agent_end", null, settled.ctx);
			expect(settled.statuses).toContainEqual(["axiom.cost", "$0.5000"]);
			log.push("override repriced the run: recorded $9.00 -> shown $0.50");
			// 3. /cost notes the repricing (the run's message is in the session)
			const { ctx: costCtx, notified: costNotified } = userCtx([
				assistantEntry(
					usage({ input: 1_000_000, cost: { input: 9.0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9.0 } }),
				),
			]);
			await pi.commands.get("cost")!.handler("", fromAny<never, unknown>(costCtx));
			expect(costNotified.at(-1)).toContain("repriced at override rates");
			expect(costNotified.at(-1)).toContain("session $0.5000");
			log.push(`/cost notes -> "${costNotified.at(-1)}"`);
			// 4. the cap uses the same repriced numbers
			await writeFile(
				join(profileHome, "ledger.json"),
				JSON.stringify({
					maxRunCostUsd: 1.0,
					overrides: { "deepseek/deepseek-chat": { input: 0.5, output: 1.0, cacheRead: 0.05, cacheWrite: 0.5 } },
				}),
			);
			const { ctx: ctx2, aborted } = userCtx();
			await emitEvent(pi, "agent_start", null, ctx2);
			// First turn reprices to $0.50 — under the $1.00 cap.
			await emitEvent(
				pi,
				"turn_end",
				turnEnd(
					assistantMessage({
						provider: "deepseek",
						model: "deepseek-chat",
						usage: usage({
							input: 1_000_000,
							cost: { input: 9.0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9.0 },
						}),
					}),
				),
				ctx2,
			);
			await emitEvent(pi, "turn_start", turnStart(1), ctx2);
			expect(aborted).toEqual([]);
			// Second turn reaches $1.00 — the cap blocks before the next call.
			await emitEvent(
				pi,
				"turn_end",
				turnEnd(
					assistantMessage({
						provider: "deepseek",
						model: "deepseek-chat",
						usage: usage({
							input: 1_000_000,
							cost: { input: 9.0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9.0 },
						}),
					}),
				),
				ctx2,
			);
			await emitEvent(pi, "turn_start", turnStart(2), ctx2);
			expect(aborted).toEqual(["abort"]);
			log.push("cap judged at override prices");
		} finally {
			vi.unstubAllEnvs();
			await cleanupHome(home);
		}
		expect(log).toHaveLength(3);
	});

	it("Dana (team lead): several profiles stay strictly isolated", async () => {
		const home = await tempHome();
		const log: string[] = [];
		try {
			vi.stubEnv(AXIOM_HOME_ENV, home);
			for (const name of ["research", "writing"]) {
				expect(await handleProfileCommand(["profile", "create", name], { axiomHome: home })).toBe(true);
			}
			log.push("created profiles research + writing");
			// research remembers a fact; writing must not see it
			const researchHome = join(home, "profiles", "research");
			vi.stubEnv(AXIOM_HOME_ENV, researchHome);
			vi.stubEnv("PI_CODING_AGENT_DIR", researchHome);
			const research = bootAxiom(researchHome);
			const researchTool = research.tools.find((t) => t.name === "memory")!;
			await researchTool.execute("c1", {
				action: "add",
				content: "Research uses the mock endpoint",
				scope: "agent",
			});
			// writing boots clean: no memory, own ledger file
			const writingHome = join(home, "profiles", "writing");
			vi.stubEnv(AXIOM_HOME_ENV, writingHome);
			vi.stubEnv("PI_CODING_AGENT_DIR", writingHome);
			const writing = bootAxiom(writingHome);
			const { ctx } = userCtx();
			const mem = fromAny<
				{
					systemPrompt?: string;
				},
				unknown
			>(
				await emitEvent(
					writing,
					"before_agent_start",
					{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
					ctx,
				),
			);
			expect(mem.systemPrompt).not.toContain("mock endpoint");
			log.push("writing profile has no memory of research");
			// costs are isolated per home too
			const writingLedger = join(writingHome, "ledger.json");
			const { readFile } = await import("node:fs/promises");
			await expect(readFile(writingLedger)).rejects.toMatchObject({ code: "ENOENT" });
			log.push("writing ledger does not exist yet (isolated)");
			// profile list shows both
			const out: string[] = [];
			await handleProfileCommand(["profile", "list"], { axiomHome: home, stdout: (s) => out.push(s) });
			expect(out.join(" ")).toContain("research");
			expect(out.join(" ")).toContain("writing");
			log.push("profile list shows both profiles");
		} finally {
			vi.unstubAllEnvs();
			await cleanupHome(home);
		}
		expect(log).toHaveLength(4);
	});

	it("Kai (power user): bounded memory and model detail", async () => {
		const home = await tempHome();
		const log: string[] = [];
		try {
			const profileHome = join(home, "profiles", "ops");
			vi.stubEnv(AXIOM_HOME_ENV, profileHome);
			vi.stubEnv("PI_CODING_AGENT_DIR", profileHome);
			const pi = bootAxiom(profileHome);
			const { ctx } = userCtx();
			const tool = pi.tools.find((t) => t.name === "memory")!;
			// 1. flood memory past the default cap (50/scope)
			for (let i = 0; i < 55; i++) {
				await tool.execute("c1", { action: "add", content: `fact ${i}`, scope: "user" });
			}
			const listed = fromPartial<{
				content: Array<{ type: string; text: string }>;
			}>(await tool.execute("c1", { action: "list" }));
			const lines = listed.content[0]!.text.split("\n");
			expect(lines.length).toBe(50);
			log.push("memory capped at 50/scope after flooding 55 facts");
			// 2. the newest facts survived; the oldest were silently evicted
			expect(listed.content[0]!.text).toContain("fact 54");
			expect(listed.content[0]!.text).not.toContain("fact 0");
			log.push("eviction kept the freshest facts (fact 0 silently gone)");
			// 3. /cost with two models shows the summed totals
			await emitEvent(pi, "agent_start", null, ctx);
			await emitEvent(
				pi,
				"turn_end",
				turnEnd(
					assistantMessage({
						provider: "deepseek",
						model: "deepseek-chat",
						usage: usage({
							input: 100_000,
							cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
						}),
					}),
				),
				ctx,
			);
			await emitEvent(
				pi,
				"turn_end",
				turnEnd(
					assistantMessage({
						provider: "openai",
						model: "gpt-5.6",
						usage: usage({
							input: 100_000,
							cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
						}),
					}),
				),
				ctx,
			);
			await emitEvent(pi, "turn_start", turnStart(2), ctx);
			// /cost reads the session entries for the session totals
			const { ctx: costCtx, notified: costNotified } = userCtx([
				assistantEntry(
					usage({ input: 100_000, cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } }),
				),
				assistantEntry(
					usage({ input: 100_000, cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } }),
					"openai",
					"gpt-5.6",
				),
			]);
			await pi.commands.get("cost")!.handler("", fromAny<never, unknown>(costCtx));
			expect(costNotified.at(-1)).toContain("session $0.5100");
			log.push(`/cost totals two models -> "${costNotified.at(-1)}"`);
			// 4. the report now carries the per-model rows (regression flip from plan v2)
			expect(costNotified.at(-1)).toContain("deepseek-chat $0.0100");
			expect(costNotified.at(-1)).toContain("gpt-5.6 $0.5000");
			log.push("report shows per-model rows");
		} finally {
			vi.unstubAllEnvs();
			await cleanupHome(home);
		}
		expect(log).toHaveLength(4);
	});
});
