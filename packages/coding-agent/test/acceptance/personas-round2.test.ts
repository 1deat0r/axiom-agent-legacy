/**
 * Round-2 synthetic-user acceptance: three NEW personas (distinct from
 * round 1) re-testing the surfaces the round-1 findings fixed — the /cap
 * command, eviction visibility, /cost detail, toast next steps, profile
 * onboarding hint, and the active-profile footer status.
 * Reviews: docs/acceptance/round2.md.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleProfileCommand } from "../../src/cli/profile-command.ts";
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
} from "./helpers.ts";

describe("round-2 synthetic users", () => {
	it("Nadia (non-technical budget owner): /cap without touching files", async () => {
		const home = await tempHome();
		const log: string[] = [];
		try {
			vi.stubEnv(AXIOM_HOME_ENV, home);
			vi.stubEnv("PI_CODING_AGENT_DIR", home);
			const pi = bootAxiom(home);
			const { ctx, notified } = userCtx();
			// 1. Nadia sets the cap with a command, not a file
			await pi.commands.get("cap")!.handler("0.75", ctx as never);
			expect(notified.at(-1)).toContain("cap set to $0.75");
			log.push(`/cap 0.75 -> "${notified.at(-1)}"`);
			// 2. /cap shows the headroom without arguments
			await pi.commands.get("cap")!.handler("", ctx as never);
			expect(notified.at(-1)).toContain("cap $0.75");
			expect(notified.at(-1)).toContain("session $0.0000");
			log.push(`/cap -> "${notified.at(-1)}"`);
			// 3. the cap actually stops the run, with next steps
			const { ctx: runCtx, aborted, notified: runNotified } = userCtx();
			await emitEvent(pi, "agent_start", null, runCtx);
			await emitEvent(
				pi,
				"turn_end",
				turnEnd(
					assistantMessage({
						provider: "p",
						model: "m",
						usage: usage({
							input: 900_000,
							cost: { input: 0.9, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.9 },
						}),
					}),
				),
				runCtx,
			);
			await emitEvent(pi, "turn_start", turnStart(1), runCtx);
			expect(aborted).toEqual(["abort"]);
			expect(runNotified.at(-1)).toMatch(/run \/cost to review/i);
			expect(runNotified.at(-1)).toContain("/cap to adjust");
			log.push(`cap stop with next steps -> "${runNotified.at(-1)}"`);
			// 4. Nadia clears the cap the same way she set it
			await pi.commands.get("cap")!.handler("none", ctx as never);
			expect(notified.at(-1)).toContain("cap cleared");
			log.push("/cap none -> cap cleared");
		} finally {
			vi.unstubAllEnvs();
			await cleanupHome(home);
		}
		expect(log).toHaveLength(4);
	});

	it("Sam (ops engineer): eviction is visible and the profile is named", async () => {
		const home = await tempHome();
		const log: string[] = [];
		try {
			vi.stubEnv(AXIOM_HOME_ENV, home);
			expect(await handleProfileCommand(["profile", "create", "sre"], { axiomHome: home })).toBe(true);
			const profileHome = join(home, "profiles", "sre");
			vi.stubEnv(AXIOM_HOME_ENV, profileHome);
			vi.stubEnv("PI_CODING_AGENT_DIR", profileHome);
			const pi = bootAxiom(profileHome);
			// 1. the footer names the active profile at agent_start
			const { ctx, statuses, notified } = userCtx();
			await emitEvent(pi, "agent_start", null, ctx);
			expect(statuses).toContainEqual(["axiom.profile", "sre"]);
			log.push("footer names the active profile: sre");
			// 2. over-cap adds say so, out loud
			const tool = pi.tools.find((t) => t.name === "memory")!;
			const results: string[] = [];
			for (let i = 0; i < 52; i++) {
				const r = (await tool.execute("c1", { action: "add", content: `fact ${i}`, scope: "user" })) as {
					content: Array<{ type: string; text: string }>;
				};
				if (r.content[0]!.text.includes("evicted")) results.push(r.content[0]!.text);
			}
			expect(results.length).toBe(2); // adds 51 and 52 each evict one
			expect(results[0]).toContain("evicted 1 stale entry");
			log.push(`eviction named on 2 over-cap adds, e.g. "${results[0]}"`);
			// 3. a zero cap via /cap gives the way out
			await pi.commands.get("cap")!.handler("0", ctx as never);
			expect(notified.at(-1)).toContain("/cap none to re-enable");
			log.push("zero cap points to /cap none to re-enable");
		} finally {
			vi.unstubAllEnvs();
			await cleanupHome(home);
		}
		expect(log).toHaveLength(3);
	});

	it("Lena (client onboarder): create hint, cap line, and honest /cost rows", async () => {
		const home = await tempHome();
		const log: string[] = [];
		try {
			vi.stubEnv(AXIOM_HOME_ENV, home);
			// 1. create hints at the next steps
			const out: string[] = [];
			await handleProfileCommand(["profile", "create", "acme"], { axiomHome: home, stdout: (s) => out.push(s) });
			expect(out.join(" ")).toMatch(/--profile acme/);
			expect(out.join(" ")).toMatch(/\/login/);
			log.push("create hints: --profile acme + /login");
			// 2. /cost shows the cap line and per-model rows with an overflow note
			const profileHome = join(home, "profiles", "acme");
			vi.stubEnv(AXIOM_HOME_ENV, profileHome);
			vi.stubEnv("PI_CODING_AGENT_DIR", profileHome);
			await writeFile(join(profileHome, "ledger.json"), JSON.stringify({ maxRunCostUsd: 2 }));
			const pi = bootAxiom(profileHome);
			const entries = ["deepseek", "openai", "anthropic", "google", "mistral"].map((provider, i) => ({
				type: "message" as const,
				id: `m${i}`,
				parentId: null,
				timestamp: "2026-08-11T00:00:00.000Z",
				message: assistantMessage({
					provider,
					model: `${provider}-m`,
					usage: usage({
						input: 100_000,
						cost: { input: 0.1 * (i + 1), output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 * (i + 1) },
					}),
				}),
			}));
			const { ctx, notified } = userCtx(entries);
			await pi.commands.get("cost")!.handler("", ctx as never);
			const report = notified.at(-1)!;
			expect(report).toContain("cap $2.00");
			expect(report).toContain("mistral-m $0.5000");
			expect(report).toContain("+2 more models");
			log.push(`/cost detail -> "${report}"`);
		} finally {
			vi.unstubAllEnvs();
			await cleanupHome(home);
		}
		expect(log).toHaveLength(2);
	});
});
