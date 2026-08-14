import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowText = readFileSync(
	fileURLToPath(new URL("../../../../.github/workflows/live-verification.yml", import.meta.url)),
	"utf8",
);

const workflow = parse(workflowText) as {
	name?: string;
	on?: Record<string, unknown>;
	permissions?: Record<string, string>;
	jobs?: Record<
		string,
		{
			name?: string;
			"runs-on"?: string;
			"timeout-minutes"?: number;
			if?: string;
			env?: Record<string, string>;
			steps?: Array<{
				uses?: string;
				with?: Record<string, unknown>;
				if?: string;
				run?: string;
				id?: string;
				name?: string;
			}>;
		}
	>;
};

const liveVerificationJob = workflow.jobs?.["live-verification"];

describe(".github/workflows/live-verification.yml", () => {
	it("parses as valid YAML", () => {
		expect(workflow.name).toBe("Live verification");
	});

	it("runs on manual dispatch and on PR comments", () => {
		expect(workflow.on).toHaveProperty("workflow_dispatch");
		expect(workflow.on).toHaveProperty("issue_comment");
	});

	it("requests pull-request write and contents read permissions", () => {
		expect(workflow.permissions).toMatchObject({ contents: "read", "pull-requests": "write" });
	});

	it("runs on ubuntu with a 30 minute budget", () => {
		expect(liveVerificationJob?.["runs-on"]).toBe("ubuntu-latest");
		expect(liveVerificationJob?.["timeout-minutes"]).toBe(30);
	});

	it("only reacts to a PR comment that asks for it", () => {
		expect(liveVerificationJob?.if).toContain("github.event.issue.pull_request");
		expect(workflowText).toContain("/run-live");
	});

	it("maps repository secrets one to one onto the exact env names run.mjs reads", () => {
		for (const envName of [
			"DEEPSEEK_API_KEY",
			"OPENAI_API_KEY",
			"ANTHROPIC_API_KEY",
			"GEMINI_API_KEY",
			"AXIOM_TELEGRAM_BOT_TOKEN",
			"AXIOM_DISCORD_BOT_TOKEN",
			"AXIOM_SLACK_BOT_TOKEN",
		]) {
			expect(workflowText).toContain(`${envName}: \${{ secrets.${envName} }}`);
		}
	});

	it("builds the repo before running so the agent-run and rlm-kernel checks can load dist", () => {
		const steps = liveVerificationJob?.steps ?? [];
		expect(steps.some((step) => step.run === "npm ci")).toBe(true);
		expect(steps.some((step) => step.run === "npm run build")).toBe(true);
	});

	it("runs the harness with --json for the report", () => {
		expect(workflowText).toContain("node tools/live-verification/run.mjs --json");
	});

	it("posts the PR report only when at least one check ran (silent on all-SKIP)", () => {
		const commentStep = liveVerificationJob?.steps?.find((step) => step.run?.includes("gh pr comment"));
		expect(commentStep).toBeDefined();
		expect(commentStep?.if).toContain("steps.run.outputs.ran != '0'");
		expect(commentStep?.if).toContain("issue_comment");
	});

	it("exports ran/passed/failed counts for downstream gating", () => {
		expect(workflowText).toContain('echo "ran=$(jq -r .ran report.json)"');
		expect(workflowText).toContain('echo "passed=$(jq -r .passed report.json)"');
		expect(workflowText).toContain('echo "failed=$(jq -r .failed report.json)"');
	});
});
