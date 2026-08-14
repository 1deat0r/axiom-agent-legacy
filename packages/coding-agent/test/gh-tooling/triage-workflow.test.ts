import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
	fileURLToPath(new URL("../../../../.github/workflows/triage.yml", import.meta.url)),
	"utf8",
);

describe(".github/workflows/triage.yml", () => {
	it("triggers on opened and closed issues", () => {
		expect(workflow).toContain("issues:");
		expect(workflow).toContain("types: [opened, closed]");
	});

	it("runs the close check with the tested module", () => {
		expect(workflow).toContain("triage-close-cli.ts");
		expect(workflow).toContain("close-check");
	});

	it("posts the close-ritual reminder on the nudge decision", () => {
		expect(workflow).toContain("steps.check.outputs.action == 'nudge'");
	});

	it("requests issues write permission", () => {
		expect(workflow).toContain("issues: write");
	});

	it("classifies with the tested module", () => {
		expect(workflow).toContain("packages/coding-agent/src/core/gh-tooling/triage-cli.ts");
	});

	it("applies needs-triage on the decision", () => {
		expect(workflow).toContain("gh issue edit");
		expect(workflow).toContain("--add-label");
		expect(workflow).toContain("github.event.issue.number");
	});

	it("posts the readiness contract on the decision", () => {
		expect(workflow).toContain("gh issue comment");
		expect(workflow).toContain("--body-file");
	});

	it("passes the GITHUB_TOKEN to gh", () => {
		expect(workflow).toContain("GH_TOKEN");
	});
});
