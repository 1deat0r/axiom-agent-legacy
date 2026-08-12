import type { AuditFinding, FindingSeverity } from "./types.js";

/**
 * Structural (non-Python) scanners. Where an AST parser is unavailable (JS, due
 * to no bundled parser) or not applicable (shell, markdown fences), a curated
 * set of conservative literal scans is the best-effort static audit. Each rule
 * is kept coarse on purpose: a false positive here only surfaces as a warning
 * the operator can override; a false negative in the pipe-to-shell family is
 * the high-severity risk this scan exists to catch.
 */

interface ScanRule {
	severity: FindingSeverity;
	rule: string;
	pattern: RegExp;
	evidence: (match: RegExpExecArray) => string;
}

function applyRules(source: string, rules: readonly ScanRule[], path: string): AuditFinding[] {
	const findings: AuditFinding[] = [];
	for (const rule of rules) {
		rule.pattern.lastIndex = 0;
		let match: RegExpExecArray | null = rule.pattern.exec(source);
		while (match !== null) {
			findings.push({ severity: rule.severity, rule: rule.rule, evidence: rule.evidence(match), path });
			if (rule.pattern.global === false) break;
			match = rule.pattern.exec(source);
		}
	}
	return findings;
}

const JS_RULES: readonly ScanRule[] = [
	{
		severity: "block",
		rule: "dynamic-code",
		pattern: /\beval\s*\(|new\s+Function\s*\(/g,
		evidence: () => "dynamic JS evaluation",
	},
	{
		severity: "block",
		rule: "subprocess",
		pattern: /\bchild_process\b|\.execSync?\s*\(|\.spawn(Sync)?\s*\(|child_process\.execFile/g,
		evidence: () => "spawns OS processes",
	},
	{
		severity: "block",
		rule: "os-shell",
		pattern: /\bos\.system\s*\(|\bsys\.system\s*\(/g,
		evidence: () => "OS shell invocation",
	},
	{ severity: "warn", rule: "network", pattern: /\bfetch\s*\(|https?:\/\//g, evidence: () => "network access" },
	{
		severity: "warn",
		rule: "secret-read",
		pattern: /\bprocess\.env\b|\bprocess\.getenv\b/g,
		evidence: () => "reads process environment",
	},
	{
		severity: "warn",
		rule: "secret-read",
		pattern: /require\(["']fs["']\)[^;]*\.writeFile(Sync)?\s*\(/g,
		evidence: () => "filesystem write",
	},
	{
		severity: "warn",
		rule: "obfuscation",
		pattern: /\batob\s*\(|\bbtoa\s*\(/g,
		evidence: () => "base64 encode/decode",
	},
];

const SHELL_BLOCK_RULES: readonly ScanRule[] = [
	{
		severity: "block",
		rule: "destructive",
		pattern: /\brm\s+-rf\s+\/|\bmkfs\b/g,
		evidence: () => "destructive filesystem command",
	},
	{
		severity: "block",
		rule: "pipe-to-shell",
		pattern: /(curl|wget)\s+[^|;\n]*\|\s*(ba)?sh\b/g,
		evidence: (m) => `pipes network fetch into a shell: ${m[0].slice(0, 48)}`,
	},
	{
		severity: "block",
		rule: "reverse-shell",
		pattern: /\bbash\s+-i\b|\/dev\/tcp\//g,
		evidence: () => "reverse shell / raw tcp",
	},
	{ severity: "block", rule: "privilege", pattern: /\bsudo\s+/g, evidence: () => "privilege escalation" },
	{ severity: "block", rule: "netcat", pattern: /\bnc\s+-lvp\b/g, evidence: () => "listening netcat" },
];

const SHELL_WARN_RULES: readonly ScanRule[] = [
	{ severity: "warn", rule: "network", pattern: /\b(curl|wget|nc)\b/g, evidence: () => "network tool" },
	{ severity: "warn", rule: "dynamic-code", pattern: /\beval\b|\$\(/g, evidence: () => "command substitution / eval" },
	{
		severity: "warn",
		rule: "install",
		pattern: /\bpip\s+install\b|\bnpm\s+install\b/g,
		evidence: () => "dependency install",
	},
];

/** Scan JS/TS source. */
export function scanJavaScript(source: string, path: string): AuditFinding[] {
	return applyRules(source, JS_RULES, path);
}

/** Scan a shell script (or a shell code fence). */
export function scanShell(source: string, path: string): AuditFinding[] {
	return [...applyRules(source, SHELL_BLOCK_RULES, path), ...applyRules(source, SHELL_WARN_RULES, path)];
}

/** Scan markdown, restricting to its shell code fences. */
export function scanMarkdown(source: string, path: string): AuditFinding[] {
	const blocks: string[] = [];
	const fenceRe = /```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null = fenceRe.exec(source);
	while (match !== null) {
		blocks.push(match[1]);
		match = fenceRe.exec(source);
	}
	return blocks.flatMap((block) => scanShell(block, path));
}
