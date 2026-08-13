/**
 * `axiom skill-check [dir ...]` — validate skill directories with the real
 * loader before they ship. Reports every SKILL.md the loader would silently
 * drop (missing/empty description, unparsable frontmatter, name collision)
 * and exits 1 when any would be dropped. Motivated by a hand-written skill
 * that shipped without frontmatter and vanished from the next session's
 * prompt with only a "description is required" warning.
 *
 * Returns true when the invocation was a skill-check command.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import { runSkillCheck, type SkillCheckResult } from "../core/skill-check/check.js";

export const SKILL_CHECK_USAGE = "axiom skill-check [dir ...] [--json] [--strict]";

interface SkillCheckIo {
	log(message: string): void;
	err(message: string): void;
}

interface SkillCheckCliReport {
	ok: boolean;
	dirs: Array<{ dir: string } & SkillCheckResult>;
}

/** Default directories: the same defaults the loader scans (agent + project). */
export function defaultSkillCheckDirs(cwd: string): string[] {
	return [resolve(getAgentDir(), "skills"), resolve(cwd, CONFIG_DIR_NAME, "skills")];
}

function renderDir(result: SkillCheckResult, dir: string): string[] {
	const lines: string[] = [];
	const status = result.ok ? "OK" : "FAILED";
	lines.push(`skill-check: ${dir} — ${status} (${result.filesChecked} checked, ${result.loaded} loaded)`);
	for (const rejection of result.rejections) {
		lines.push(`  rejected: ${rejection.filePath}`);
		for (const reason of rejection.reasons) {
			lines.push(`    - ${reason}`);
		}
	}
	if (result.warnings.length > 0) {
		lines.push(`  warnings:`);
		for (const warning of result.warnings) {
			lines.push(`    ${warning.path ?? "?"}: ${warning.message}`);
		}
	}
	return lines;
}

/** Handle `axiom skill-check ...`; returns true when it was a skill-check invocation. */
export function handleSkillCheckCommand(
	args: string[],
	io: SkillCheckIo = { log: (m) => console.log(m), err: (m) => console.error(m) },
): boolean {
	if (args[0] !== "skill-check") return false;

	if (args.includes("--help") || args.includes("-h")) {
		io.log(
			`${SKILL_CHECK_USAGE}\n\nValidate skill directories with the real skill loader before they ship.\nA rejected skill (missing/empty description, unparsable frontmatter, name\ncollision) is silently absent from the next session's prompt; skill-check\nreports it and exits 1. Warnings (e.g. a name that does not match its\ndirectory) still load; --strict exits 1 on them too.\n\nNo directory arguments check the default skill dirs (agent + project).`,
		);
		return true;
	}

	const strict = args.includes("--strict");
	const json = args.includes("--json");
	const explicitDirs = args
		.slice(1)
		.filter((arg) => arg !== "--strict" && arg !== "--json")
		.map((dir) => resolve(dir));

	// An explicitly named directory must exist (mirrors skill-audit). A
	// missing DEFAULT directory is normal and the loader treats it as empty,
	// so skip it silently.
	for (const dir of explicitDirs) {
		if (!isDirectory(dir)) {
			io.err(`skill-check: directory does not exist: ${dir}`);
			process.exitCode = 1;
			return true;
		}
	}

	const dirs =
		explicitDirs.length > 0
			? explicitDirs
			: defaultSkillCheckDirs(process.cwd()).filter((dir) => isDirectory(dir));

	const results = dirs.map((dir) => ({ dir, result: runSkillCheck(dir) }));
	const report: SkillCheckCliReport = {
		ok: results.every(({ result }) => result.ok && (!strict || result.warnings.length === 0)),
		dirs: results.map(({ dir, result }) => ({ dir, ...result })),
	};

	if (json) {
		io.log(JSON.stringify(report));
	} else {
		for (const { dir, result } of results) {
			io.log(renderDir(result, dir).join("\n"));
		}
		const rejections = results.reduce((sum, { result }) => sum + result.rejections.length, 0);
		const warnings = results.reduce((sum, { result }) => sum + result.warnings.length, 0);
		const verdict = report.ok
			? `skill-check: OK${strict ? " (strict)" : ""}`
			: `skill-check: FAILED (${rejections} rejected, ${warnings} warning${warnings === 1 ? "" : "s"})`;
		io.log(verdict);
	}

	if (!report.ok) {
		process.exitCode = 1;
	}
	return true;
}

function isDirectory(dir: string): boolean {
	try {
		return statSync(dir).isDirectory();
	} catch {
		return false;
	}
}
