/**
 * `axiom skill-audit` — step 2 of procedural-memory skills: statically audit a
 * skill directory before it is run/installed, mirroring Hermes' skills_ast_audit
 * + skills_guard. Python is AST-parsed; JS/shell/markdown get structural scans.
 * Returns true when the invocation was a skill-audit command.
 */
import { existsSync } from "node:fs";
import { auditSkill } from "../core/skill-audit/index.js";
import type { AuditFinding, AuditVerdict } from "../core/skill-audit/types.js";

export const SKILL_AUDIT_USAGE = "axiom skill-audit <dir> [--json]";

interface SkillAuditIo {
	log(message: string): void;
	err(message: string): void;
}

function formatVerdict(verdict: AuditVerdict): string {
	switch (verdict) {
		case "block":
			return "BLOCK";
		case "warn":
			return "WARN";
		default:
			return "ALLOW";
	}
}

/** Plain-text rendering for humans. */
export function renderSkillAudit(
	verdict: AuditVerdict,
	findings: readonly AuditFinding[],
	filesScanned: readonly string[],
): string {
	const lines: string[] = [];
	lines.push(
		`Skill audit verdict: ${formatVerdict(verdict)} (${findings.length} finding${findings.length === 1 ? "" : "s"}, ${filesScanned.length} file${filesScanned.length === 1 ? "" : "s"} scanned)`,
	);
	for (const finding of findings) {
		lines.push(
			`  [${finding.severity.toUpperCase()}] ${finding.rule} — ${finding.evidence}${finding.line ? ` (line ${finding.line})` : ""}`,
		);
	}
	if (findings.length === 0) {
		lines.push("  no findings.");
	}
	return lines.join("\n");
}

/** Handle `axiom skill-audit ...`; returns true when it was a skill-audit invocation. */
export function handleSkillAuditCommand(
	args: string[],
	io: SkillAuditIo = { log: (m) => console.log(m), err: (m) => console.error(m) },
): boolean {
	if (args[0] !== "skill-audit") return false;
	if (args.includes("--help") || args.includes("-h")) {
		io.log(
			`${SKILL_AUDIT_USAGE}\n\nStatically audit a skill directory before running a third-party skill.\nPython is AST-parsed; JS/shell/markdown get structural scans. Verdicts:\nBLOCK (stop), WARN (review), ALLOW.`,
		);
		return true;
	}
	const dir = args[1];
	if (!dir || dir.startsWith("--")) {
		io.err(`usage: ${SKILL_AUDIT_USAGE}`);
		return true;
	}
	if (!existsSync(dir)) {
		io.err(`skill-audit: directory does not exist: ${dir}`);
		return true;
	}
	const report = auditSkill(dir);
	if (args.includes("--json")) {
		io.log(JSON.stringify(report));
		return true;
	}
	io.log(renderSkillAudit(report.verdict, report.findings, report.filesScanned));
	return true;
}
