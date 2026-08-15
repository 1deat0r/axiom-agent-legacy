import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillPath = fileURLToPath(new URL("../../skills/ast-grep/SKILL.md", import.meta.url));

function readSkill(): string {
	return readFileSync(skillPath, "utf8");
}

describe("ast-grep skill content (recipe correctness, finding F1)", () => {
	it("uses the plural --globs flag and never the non-existent --glob", () => {
		const text = readSkill();
		expect(text).toContain("--globs");
		expect(text).not.toMatch(/--glob(?!s)/);
	});

	it("never documents --filter (does not exist in the ast-grep CLI)", () => {
		expect(readSkill()).not.toContain("--filter");
	});

	it("never passes --lang more than once in a single command", () => {
		const text = readSkill();
		for (const line of text.split("\n")) {
			const codeLine = line.startsWith("```") ? "" : line;
			const langFlags = (codeLine.match(/--lang/g) ?? []).length;
			expect(langFlags, `line has ${langFlags} --lang flags: ${line}`).toBeLessThanOrEqual(1);
		}
	});
});
