import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CHECKS,
	type CheckDeps,
	type CheckEnv,
	GATEWAY_TOKEN_ENV_VARS,
	missingRequirements,
	PROVIDER_KEY_ENV_VARS,
	plan,
	SOCKET_MODE_TOKEN_ENV_VARS,
	summarize,
} from "../../../tools/live-verification/catalog.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RUN_MJS = join(REPO_ROOT, "tools/live-verification/run.mjs");

/** Test environment with every live credential scrubbed. */
function keylessEnv(): CheckEnv {
	const env: CheckEnv = { ...process.env };
	for (const key of [
		...PROVIDER_KEY_ENV_VARS,
		...GATEWAY_TOKEN_ENV_VARS,
		...SOCKET_MODE_TOKEN_ENV_VARS,
		"AXIOM_KERNEL_PYTHON",
	]) {
		delete env[key];
	}
	return env;
}

/** Deps that report a fully built worktree but no kernel python. */
function readyDeps(overrides: Partial<CheckDeps> = {}): CheckDeps {
	return {
		cliJsExists: () => true,
		kernelModuleExists: () => true,
		gatewayCronModuleExists: () => true,
		resolveKernelPython: () => null,
		...overrides,
	};
}

describe("live-verification catalog", () => {
	it("catalogs exactly the six required live checks", () => {
		expect(CHECKS.map((check) => check.id)).toEqual([
			"provider-chat",
			"agent-run",
			"rlm-kernel",
			"gateway-delivery",
			"slack-socket-mode",
			"cron-spine",
		]);
	});

	it("gives every check a name, a purpose, and an expected output", () => {
		for (const check of CHECKS) {
			expect(check.name.length).toBeGreaterThan(0);
			expect(check.purpose.length).toBeGreaterThan(0);
			expect(check.expectedOutput.length).toBeGreaterThan(0);
		}
	});

	it("declares env vars or extra requirements for every check", () => {
		for (const check of CHECKS) {
			const hasEnvGate = check.envVars !== undefined;
			const hasExtra = (check.extraRequirements ?? []).length > 0;
			expect(hasEnvGate || hasExtra).toBe(true);
		}
	});

	it("gates the two provider checks on any configured provider key", () => {
		for (const id of ["provider-chat", "agent-run"]) {
			const check = CHECKS.find((entry) => entry.id === id);
			expect(check?.envVars).toEqual({ anyOf: PROVIDER_KEY_ENV_VARS });
		}
	});

	it("gates gateway delivery on any configured transport token", () => {
		const check = CHECKS.find((entry) => entry.id === "gateway-delivery");
		expect(check?.envVars).toEqual({ anyOf: GATEWAY_TOKEN_ENV_VARS });
	});

	it("gates socket mode on the Slack app token", () => {
		const check = CHECKS.find((entry) => entry.id === "slack-socket-mode");
		expect(check?.envVars).toEqual({ anyOf: SOCKET_MODE_TOKEN_ENV_VARS });
	});
});

describe("missingRequirements", () => {
	it("reports the whole anyOf group when no key is present", () => {
		const check = CHECKS.find((entry) => entry.id === "provider-chat");
		if (!check) throw new Error("provider-chat missing");
		const missing = missingRequirements(check, keylessEnv(), readyDeps());
		expect(missing).toEqual([`one of: ${PROVIDER_KEY_ENV_VARS.join(", ")}`]);
	});

	it("reports nothing when one member of the anyOf group is present", () => {
		const check = CHECKS.find((entry) => entry.id === "provider-chat");
		if (!check) throw new Error("provider-chat missing");
		expect(missingRequirements(check, { OPENAI_API_KEY: "k" }, readyDeps())).toEqual([]);
	});

	it("reports the kernel python and dist prerequisites for rlm-kernel", () => {
		const check = CHECKS.find((entry) => entry.id === "rlm-kernel");
		if (!check) throw new Error("rlm-kernel missing");
		const missing = missingRequirements(check, keylessEnv(), readyDeps({ kernelModuleExists: () => false }));
		expect(missing.some((reason) => reason.includes("AXIOM_KERNEL_PYTHON"))).toBe(true);
		expect(missing.some((reason) => reason.includes("npm run build"))).toBe(true);
	});
});

describe("plan", () => {
	it("skips every check when the environment has no keys and nothing is built", () => {
		const { runnable, skipped } = plan(CHECKS, keylessEnv(), readyDeps({ gatewayCronModuleExists: () => false }));
		expect(runnable).toEqual([]);
		expect(skipped).toHaveLength(CHECKS.length);
		for (const entry of skipped) expect(entry.reasons.length).toBeGreaterThan(0);
	});

	it("runs cron-spine even with no keys when the gateway module is built", () => {
		const { runnable, skipped } = plan(CHECKS, keylessEnv(), readyDeps());
		expect(runnable.map((check) => check.id)).toEqual(["cron-spine"]);
		expect(skipped.map((entry) => entry.check.id).sort()).toEqual([
			"agent-run",
			"gateway-delivery",
			"provider-chat",
			"rlm-kernel",
			"slack-socket-mode",
		]);
	});

	it("runs only the checks whose requirements are met", () => {
		const env: CheckEnv = { DEEPSEEK_API_KEY: "k" };
		const { runnable, skipped } = plan(CHECKS, env, readyDeps());
		expect(runnable.map((check) => check.id)).toEqual(["provider-chat", "agent-run", "cron-spine"]);
		expect(skipped.map((entry) => entry.check.id).sort()).toEqual([
			"gateway-delivery",
			"rlm-kernel",
			"slack-socket-mode",
		]);
	});

	it("runs all six checks when keys, tokens, and a kernel python are present", () => {
		const env: CheckEnv = {
			DEEPSEEK_API_KEY: "k",
			AXIOM_TELEGRAM_BOT_TOKEN: "t",
			AXIOM_SLACK_APP_TOKEN: "a",
			AXIOM_KERNEL_PYTHON: "/usr/bin/python3",
		};
		const { runnable } = plan(CHECKS, env, readyDeps({ resolveKernelPython: () => "/usr/bin/python3" }));
		expect(runnable.map((check) => check.id)).toEqual(CHECKS.map((check) => check.id));
	});
});

describe("summarize", () => {
	function result(id: string, outcome: "pass" | "fail" | "skip") {
		const check = CHECKS.find((entry) => entry.id === id);
		if (!check) throw new Error(`unknown check ${id}`);
		return { check, outcome, detail: `${id} detail` };
	}

	it("never fails when everything is skipped", () => {
		const summary = summarize(CHECKS.map((check) => ({ check, outcome: "skip" as const, detail: "no keys" })));
		expect(summary.exitCode).toBe(0);
		expect(summary.skipped).toBe(CHECKS.length);
		expect(summary.ran).toBe(0);
		expect(summary.lines.join("\n")).toContain("SKIP");
	});

	it("fails only when a check that ran failed", () => {
		const summary = summarize([
			result("provider-chat", "pass"),
			result("agent-run", "fail"),
			result("rlm-kernel", "skip"),
		]);
		expect(summary.exitCode).toBe(1);
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(1);
		expect(summary.ran).toBe(2);
		expect(summary.lines.join("\n")).toContain("FAIL");
	});

	it("exits zero when every check that ran passed", () => {
		const summary = summarize([result("provider-chat", "pass"), result("rlm-kernel", "skip")]);
		expect(summary.exitCode).toBe(0);
		expect(summary.failed).toBe(0);
	});
});

describe("run.mjs (offline, no keys)", () => {
	const kernelProbeScrub: CheckEnv = {
		...keylessEnv(),
		// Force the kernel python probe to miss so the offline run never boots a kernel.
		AXIOM_KERNEL_PYTHON: "/nonexistent/live-check-python",
		AXIOM_KERNEL_VENV: mkdtempSync(join(tmpdir(), "live-check-venv-")),
		// Force the cron-spine module probe to miss so the offline run never
		// loads the compiled gateway (the build may or may not exist here).
		LIVE_CHECK_GATEWAY_MODULE: "/nonexistent/live-check-gateway-cron.js",
	};

	function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
		const result = spawnSync(process.execPath, [RUN_MJS, ...args], {
			encoding: "utf8",
			env: kernelProbeScrub,
			cwd: REPO_ROOT,
			timeout: 30_000,
		});
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	}

	it("exits 0 with every check SKIP when no keys are present", () => {
		const run = runCli(["--json"]);
		expect(run.status).toBe(0);
		const report = JSON.parse(run.stdout) as {
			ran: number;
			skipped: number;
			passed: number;
			failed: number;
			exitCode: number;
			results: Array<{ id: string; outcome: string }>;
		};
		expect(report.ran).toBe(0);
		expect(report.skipped).toBe(CHECKS.length);
		expect(report.passed).toBe(0);
		expect(report.failed).toBe(0);
		expect(report.exitCode).toBe(0);
		expect(report.results.every((entry) => entry.outcome === "skip")).toBe(true);
		expect(report.results.map((entry) => entry.id).sort()).toEqual(CHECKS.map((check) => check.id).sort());
	});

	it("exits 0 with a SKIP for a single selected check without keys", () => {
		const run = runCli(["--check", "provider-chat", "--json"]);
		expect(run.status).toBe(0);
		const report = JSON.parse(run.stdout) as { ran: number; results: Array<{ id: string; outcome: string }> };
		expect(report.ran).toBe(0);
		expect(report.results).toHaveLength(1);
		expect(report.results[0]).toMatchObject({ id: "provider-chat", outcome: "skip" });
	});

	it("lists every check with its env requirements and expected output", () => {
		const run = runCli(["--list"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("provider-chat");
		expect(run.stdout).toContain("agent-run");
		expect(run.stdout).toContain("rlm-kernel");
		expect(run.stdout).toContain("gateway-delivery");
		expect(run.stdout).toContain("cron-spine");
		expect(run.stdout).toContain("env:");
		expect(run.stdout).toContain("expects:");
	});

	it("rejects an unknown check id with a usage exit", () => {
		const run = runCli(["--check", "no-such-check"]);
		expect(run.status).toBe(2);
		expect(run.stderr + run.stdout).toContain("no-such-check");
	});
});
