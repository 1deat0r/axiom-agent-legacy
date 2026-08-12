/**
 * Skill security audit — step 2 of the procedural-memory skills feature.
 *
 * Mirrors Hermes' `skills_ast_audit` + `skills_guard`: before a third-party
 * skill is run (or installed), its executable content is statically inspected.
 * Python is audited at the AST level (via the host `python3 -m ast` on a
 * subprocess); JS and shell are audited with structural pattern scans, and the
 * bundled SKILL.md with a shell-code-fence scan. A conservative verdict is
 * derived so untrusted skills can be blocked or flagged before they run.
 */

export type FindingSeverity = "block" | "warn" | "info";

export interface AuditFinding {
	severity: FindingSeverity;
	/** Stable rule id, e.g. "dynamic-code", "network", "sensitive-import". */
	rule: string;
	/** Short human evidence string. */
	evidence: string;
	/** Relative path of the audited file (within the audited skill root). */
	path: string;
	/** Optional 1-based line number. */
	line?: number;
}

export type AuditVerdict = "allow" | "warn" | "block";

export interface SkillAuditReport {
	verdict: AuditVerdict;
	findings: AuditFinding[];
	/** Files inspected for executable content. */
	filesScanned: string[];
	/** Files parsed at the Python AST level. */
	astParsed: string[];
	/** Reasons the audit could not be authoritative (e.g. python3 absent). */
	notes: string[];
}

export interface SkillAuditOptions {
	/** Fall back to structural scanning for Python when the AST pass is unavailable. */
	structuralFallback?: boolean;
	/** Override the python3 binary (default "python3"). */
	pythonBinary?: string;
	/** Max bytes per file to scan (default 1 MiB). */
	maxFileBytes?: number;
}
