import { existsSync } from "node:fs";
import { getAgentDir } from "../../config.js";
import type { ResourceDiagnostic } from "../diagnostics.js";
import { loadSkills } from "../skills.js";

/**
 * `skill-check` core: report every skill file a directory's loader would drop,
 * derived from the loader's own output so the check can never drift from
 * loader semantics.
 *
 * A real session loads a skill directory through the full `loadSkills` path
 * (which also applies name-collision dedupe), so the check runs the same
 * path: the loader either loads a file (it appears in `skills`), or skips it
 * and records a diagnostic pointing at the file. "Rejected" is exactly a
 * diagnostic whose path is not among the loaded skills. Files the loader
 * never saw (ignored, dot-dirs, node_modules) produce no diagnostic and are
 * not reported.
 */

/** One skill file the loader would drop, with the loader's reasons. */
export interface SkillCheckRejection {
	filePath: string;
	reasons: string[];
}

/** Per-directory outcome of a skill check. */
export interface SkillCheckResult {
	/** True when no skill file would be dropped by the loader. */
	ok: boolean;
	/** Skill files the loader examined (loaded or rejected). */
	filesChecked: number;
	/** Skill files that loaded cleanly enough to reach the prompt. */
	loaded: number;
	/** Skill files the loader dropped (missing description, parse failure, collision). */
	rejections: SkillCheckRejection[];
	/** Loader diagnostics for skills that DID load (e.g. name mismatches). */
	warnings: ResourceDiagnostic[];
}

/**
 * Run a skill check over one directory using the real loader.
 * Mirrors a session's own load path: the directory is passed as an explicit
 * skill path with defaults disabled, so name collisions dedupe exactly as
 * they would in a session. A missing directory is not an error (the loader
 * records a diagnostic; nothing was checked).
 */
export function runSkillCheck(dir: string, cwd = process.cwd()): SkillCheckResult {
	const result = loadSkills({
		cwd,
		agentDir: getAgentDir(),
		skillPaths: [dir],
		includeDefaults: false,
	});

	const loadedPaths = new Set(result.skills.map((skill) => skill.filePath));
	const diagnosticsByPath = new Map<string, ResourceDiagnostic[]>();
	for (const diagnostic of result.diagnostics) {
		if (!diagnostic.path) continue;
		const list = diagnosticsByPath.get(diagnostic.path) ?? [];
		list.push(diagnostic);
		diagnosticsByPath.set(diagnostic.path, list);
	}

	const rejections: SkillCheckRejection[] = [];
	const warnings: ResourceDiagnostic[] = [];
	for (const [filePath, diagnostics] of diagnosticsByPath) {
		if (loadedPaths.has(filePath)) {
			warnings.push(...diagnostics);
		} else if (existsSync(filePath)) {
			rejections.push({ filePath, reasons: diagnostics.map((d) => d.message) });
		}
	}

	// Deterministic report ordering.
	rejections.sort((a, b) => a.filePath.localeCompare(b.filePath));
	warnings.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""));

	// Count only paths that name a file the loader examined; a missing
	// directory's "does not exist" diagnostic names no file.
	const filesChecked = [...loadedPaths, ...diagnosticsByPath.keys()].filter((path) => existsSync(path)).length;

	return {
		ok: rejections.length === 0,
		filesChecked,
		loaded: result.skills.length,
		rejections,
		warnings,
	};
}
