/**
 * OS-tier confinement integration — real bubblewrap, real filesystem.
 *
 * Drives the full CliCompletionRunner against an anchored project root so the
 * child (the "agent") runs inside the bwrap sandbox. The child attempts real
 * host filesystem operations and records outcomes into the project root, which
 * persists through the sandbox back to the host for assertion.
 *
 * Proofs (all OS-level — outside the sandbox a non-root user CAN write its own
 * home, so a blocked host-home write proves the read-only bind refused it):
 *   - inside-project write persists to host
 *   - operator-home write BLOCKED + no host artifact
 *   - ~/.ssh sentinel unreadable (shadowed)
 *   - /etc write BLOCKED (read-only host)
 *
 * Self-skips with a reason when bwrap / unprivileged userns is unavailable, so
 * CI stays green everywhere.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bwrapCreatesNamespace } from "../../src/extensions/workspace/sandbox.js";
import { CliCompletionRunner } from "../../src/gateway/completion.js";

const bwrapUsable = bwrapCreatesNamespace(process.env);
const maybeDescribe = bwrapUsable ? describe : describe.skip;
maybeDescribe("OS-tier confinement (real bwrap)", () => {
	let state:
		| {
				result: { reply: string; error?: string };
				report: { inside?: string; homeW?: string; etc?: string; ssh?: string; confined?: string | null };
				insidePersists: boolean;
				escapeOnHost: boolean;
		  }
		| undefined;
	const sentinelPath = join(homedir(), ".ssh", "axiom-cnt-sentinel");
	const escapePath = join(homedir(), "axiom-cnt-escape.txt");

	async function runFixtureOnce(): Promise<void> {
		const dir = await mkdtemp(join(tmpdir(), "axiom-cnt-"));
		try {
			const projectRoot = join(dir, "project");
			await mkdir(projectRoot, { recursive: true });
			const out = join(projectRoot, "out");
			await mkdir(out, { recursive: true });

			// host side: sentinel hidden inside ~/.ssh (shadowed) + escape path in home
			await mkdir(join(homedir(), ".ssh"), { recursive: true });
			await writeFile(sentinelPath, "TOP-SECRET");
			await rm(escapePath, { force: true });

			const fixture = join(projectRoot, "fixture.mjs");
			await writeFile(
				fixture,
				[
					"#!/usr/bin/env node",
					'import { writeFileSync } from "node:fs";',
					'import { readFile } from "node:fs/promises";',
					"const project = process.env.AXIOM_PROJECT_ROOT;",
					"const out = {};",
					`try { writeFileSync(project + '/inside.txt', 'x'); out.inside = 'ok'; } catch { out.inside = 'blocked'; }`,
					`try { writeFileSync(${JSON.stringify(escapePath)}, 'x'); out.homeW = 'ok'; } catch { out.homeW = 'blocked'; }`,
					"try { writeFileSync('/etc/axiom-cnt-escape.txt', 'x'); out.etc = 'ok'; } catch { out.etc = 'blocked'; }",
					`try { const v = await readFile(${JSON.stringify(sentinelPath)}, 'utf8'); out.ssh = v.trim(); } catch { out.ssh = 'missing'; }`,
					"out.confined = process.env.AXIOM_CONFINED ?? null;",
					"writeFileSync(project + '/out/report.json', JSON.stringify(out));",
					'process.stdout.write("done\\n");',
				].join("\n"),
			);
			await chmod(fixture, 0o755);

			const runner = new CliCompletionRunner({
				bin: fixture,
				printFlag: "-p",
				projectRoot,
				// containment: stores under the tmp project — touches nothing real
				confinement: {
					axiomHome: join(projectRoot, "stores", "axiom"),
					agentHome: join(projectRoot, "stores", "agent"),
				},
			});
			const result = await runner.runCompletion({
				sessionId: "gw-cnt",
				prompt: "probe",
				profile: { name: "default" },
			});

			let report: { inside?: string; homeW?: string; etc?: string; ssh?: string; confined?: string | null } = {};
			try {
				report = JSON.parse(await readFile(join(out, "report.json"), "utf8")) as typeof report;
			} catch {
				/* child may have failed to boot */
			}

			let insidePersists = false;
			try {
				await readFile(join(projectRoot, "inside.txt"), "utf8");
				insidePersists = true;
			} catch {
				insidePersists = false;
			}

			let escapeOnHost = false;
			try {
				await readFile(escapePath, "utf8");
				escapeOnHost = true;
			} catch {
				escapeOnHost = false;
			}

			state = { result, report, insidePersists, escapeOnHost };
		} finally {
			await rm(escapePath, { force: true });
			await rm(sentinelPath, { force: true });
			await rm(join("/etc", "axiom-cnt-escape.txt"), { force: true }).catch(() => undefined);
			await rm(dir, { recursive: true, force: true });
		}
	}

	beforeAll(async () => {
		await runFixtureOnce();
	});
	afterAll(async () => {
		state = undefined;
	});

	it("boots the child and marks it confined", () => {
		expect(state?.result.error).toBeUndefined();
		expect(state?.result.reply).toContain("done");
		expect(state?.report.confined).toBe("1");
	});

	it("persists writes inside the project root to the host", () => {
		expect(state?.report.inside).toBe("ok");
		expect(state?.insidePersists).toBe(true);
	});

	it("REFUSES (OS-level) a write to the operator home — no host artifact", () => {
		expect(state?.report.homeW).toBe("blocked");
		expect(state?.escapeOnHost).toBe(false);
	});

	it("blocks a write to /etc (read-only host)", () => {
		expect(state?.report.etc).toBe("blocked");
	});

	it("shadows ~/.ssh so the sentinel is unreadable", () => {
		expect(state?.report.ssh).toBe("missing");
	});
});
