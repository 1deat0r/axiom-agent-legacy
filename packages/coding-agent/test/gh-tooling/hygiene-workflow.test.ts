import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowText = readFileSync(
	fileURLToPath(new URL("../../../../.github/workflows/issue-hygiene.yml", import.meta.url)),
	"utf8",
);

const workflow = parse(workflowText) as {
	name?: string;
	on?: Record<string, unknown>;
	permissions?: Record<string, string>;
	jobs?: Record<
		string,
		{
			runsOn?: string;
			env?: Record<string, string>;
			steps?: Array<{ uses?: string; with?: Record<string, unknown>; if?: string; run?: string; id?: string }>;
		}
	>;
};

describe(".github/workflows/issue-hygiene.yml", () => {
	it("parses as valid YAML", () => {
		expect(workflow.name).toBe("Issue hygiene sweep");
	});

	it("runs on a weekly schedule and manual dispatch", () => {
		expect(workflow.on).toHaveProperty("schedule");
		expect(workflow.on).toHaveProperty("workflow_dispatch");
	});

	it("requests issues write and contents read permissions", () => {
		expect(workflow.permissions).toMatchObject({ contents: "read", issues: "write" });
	});

	it("passes the GITHUB_TOKEN to gh", () => {
		expect(workflowText).toContain("GH_TOKEN");
	});

	it("classifies with the tested module", () => {
		expect(workflowText).toContain("packages/coding-agent/src/core/gh-tooling/hygiene-cli.ts");
	});

	it("lists issues with the gh ceiling instead of --paginate", () => {
		expect(workflowText).toContain("--limit 1000");
		expect(workflowText).not.toContain("--paginate");
	});

	it("fetches full history so branch ahead counts are real", () => {
		const checkout = workflow.jobs?.sweep?.steps?.find((step) => step.uses === "actions/checkout@v4");
		expect(checkout?.with).toMatchObject({ "fetch-depth": 0 });
	});

	it("posts one summary comment only on the post decision", () => {
		expect(workflowText).toContain("steps.sweep.outputs.action == 'post'");
		expect(workflowText).toContain("gh issue comment");
		expect(workflowText).toContain("--body-file");
	});

	it("targets the summary issue from the repository variable", () => {
		expect(workflowText).toContain("vars.HYGIENE_SUMMARY_ISSUE");
	});

	it("never edits labels or closes issues", () => {
		expect(workflowText).not.toContain("--add-label");
		expect(workflowText).not.toContain("--remove-label");
		expect(workflowText).not.toContain("gh issue close");
		expect(workflowText).not.toContain("gh issue edit");
	});
});
