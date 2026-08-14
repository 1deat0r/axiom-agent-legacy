import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_LABELS, TRIAGE_ROLES, WAYFINDER_LABELS } from "../../src/core/gh-tooling/triage.js";

function templateUrl(name: string): URL {
	return new URL(`../../../../.github/ISSUE_TEMPLATE/${name}`, import.meta.url);
}

function read(name: string): string {
	return readFileSync(templateUrl(name), "utf8");
}

describe("issue templates", () => {
	it("has both forms and the config", () => {
		for (const name of ["agent-task.yml", "bug-report.yml", "config.yml"]) {
			expect(existsSync(fileURLToPath(templateUrl(name))), `${name} exists`).toBe(true);
		}
	});

	it("pre-applies only labels from the vocabulary", () => {
		for (const file of ["agent-task.yml", "bug-report.yml"]) {
			const text = read(file);
			const match = text.match(/labels:\s*\[([^\]]*)\]/);
			expect(match, `${file} has a labels field`).not.toBeNull();
			const labels = (match?.[1] ?? "")
				.split(",")
				.map((label) => label.trim())
				.filter(Boolean);
			expect(labels.length, `${file} pre-applies one label`).toBeGreaterThan(0);
			for (const label of labels) {
				expect(ALL_LABELS, `${label} is in the vocabulary`).toContain(label);
			}
		}
	});

	it("the agent form carries all five contract parts", () => {
		const text = read("agent-task.yml");
		for (const part of ["Goal", "Acceptance criteria", "Scope", "ADR status", "Verification plan"]) {
			expect(text, `${part} is in the agent form`).toContain(part);
		}
	});

	it("the bug form carries the bug parts", () => {
		const text = read("bug-report.yml");
		for (const part of ["What happened", "What you expected", "Steps to reproduce", "Evidence", "Environment"]) {
			expect(text, `${part} is in the bug form`).toContain(part);
		}
	});

	it("blank issues are off", () => {
		expect(read("config.yml")).toContain("blank_issues_enabled: false");
	});

	it("the vocabulary is exactly ten labels", () => {
		expect(TRIAGE_ROLES).toHaveLength(5);
		expect(WAYFINDER_LABELS).toHaveLength(5);
	});
});

describe("role guidance", () => {
	it("the agent form names both role labels and defers the role to triage", () => {
		const text = read("agent-task.yml");
		expect(text).toContain("needs-triage");
		expect(text).toContain("ready-for-agent");
		expect(text).not.toContain("Triage role");
		expect(text).toContain("pre-applies");
	});

	it("the bug form says the form itself pre-applies needs-triage", () => {
		const text = read("bug-report.yml");
		expect(text).toContain("pre-applies");
		expect(text).not.toContain("The triage workflow applies");
	});
});
