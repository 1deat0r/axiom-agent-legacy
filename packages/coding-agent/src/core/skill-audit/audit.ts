import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { analyzePythonAst } from "./python-ast.js";
import { scanJavaScript, scanMarkdown, scanShell } from "./rules.js";
import type { AuditFinding, AuditVerdict, SkillAuditOptions, SkillAuditReport } from "./types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", "dist", ".venv", "venv"]);
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Derive a conservative verdict: any block -> block; else any warn -> warn; else allow. */
export function chooseVerdict(findings: readonly AuditFinding[]): AuditVerdict {
	if (findings.some((finding) => finding.severity === "block")) return "block";
	if (findings.some((finding) => finding.severity === "warn")) return "warn";
	return "allow";
}

/** Collect the (sorted) file paths under a skill root that may carry executable content. */
export function collectSkillFiles(root: string): string[] {
	const out: string[] = [];
	const visit = (dir: string): void => {
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
				if (entry.name.startsWith(".")) continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (SKIP_DIRS.has(entry.name)) continue;
					visit(full);
					continue;
				}
				if (!entry.isFile()) continue;
				out.push(full);
			}
		} catch {
			return;
		}
	};
	visit(root);
	return out;
}

function classify(path: string): "python" | "js" | "shell" | "markdown" | "other" {
	const ext = extname(path).toLowerCase();
	if (ext === ".py" || ext === ".pyw") return "python";
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts" || ext === ".tsx") return "js";
	if (ext === ".sh" || ext === ".bash") return "shell";
	if (ext === ".md" || ext === ".markdown" || basename(path) === "SKILL.md") return "markdown";
	if (ext === "" && basename(path).startsWith(".") === false) return "other";
	return "other";
}

/**
 * Audit a skill directory for dangerous executable content. Python is parsed at
 * the AST level (subprocess `python3 -m ast`); JS/shell/markdown use structural
 * scans. Returns a report with a conservative verdict.
 */
export function auditSkill(dir: string, options: SkillAuditOptions = {}): SkillAuditReport {
	const root = resolve(dir);
	const findings: AuditFinding[] = [];
	const filesScanned: string[] = [];
	const astParsed: string[] = [];
	const notes: string[] = [];
	const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_BYTES;
	const structuralFallback = options.structuralFallback ?? true;
	const pythonBinary = options.pythonBinary ?? "python3";

	if (!existsSync(root)) {
		return {
			verdict: "block",
			findings: [{ severity: "block", rule: "missing", evidence: "audited directory does not exist", path: dir }],
			filesScanned,
			astParsed,
			notes: ["directory not found"],
		};
	}

	for (const file of collectSkillFiles(root)) {
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(file);
		} catch {
			continue;
		}
		if (!stats.isFile() || stats.size > maxBytes) continue;
		let source: string;
		try {
			source = readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		const rel = relative(root, file);
		const kind = classify(file);
		switch (kind) {
			case "python": {
				const result = analyzePythonAst(file, source, pythonBinary);
				if (result.available) {
					astParsed.push(rel);
					findings.push(...result.findings);
				} else if (structuralFallback) {
					notes.push(`python AST unavailable for ${rel}; fell back to structural scan`);
					findings.push(...scanShell(source, rel));
				} else {
					notes.push(`python AST unavailable for ${rel}; skipped`);
				}
				break;
			}
			case "js":
				findings.push(...scanJavaScript(source, rel));
				break;
			case "shell":
				findings.push(...scanShell(source, rel));
				break;
			case "markdown":
				findings.push(...scanMarkdown(source, rel));
				break;
			default:
				break;
		}
		filesScanned.push(rel);
	}

	return { verdict: chooseVerdict(findings), findings, filesScanned, astParsed, notes };
}
