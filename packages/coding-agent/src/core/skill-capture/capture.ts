import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkillsFromDir } from "../skills.js";
import type { CapturedSkillDocument, PersistResult, VerifyResult } from "./types.js";

/**
 * Persist a captured skill document to `<outputDir>/<name>/SKILL.md`, refusing
 * to overwrite an existing skill (an overwrite would clobber a hand-written or
 * previously captured skill and silently change behavior).
 */
export function persistCapturedSkill(outputDir: string, document: CapturedSkillDocument): PersistResult {
	const target = join(outputDir, document.directoryName, "SKILL.md");
	if (existsSync(target)) {
		return { ok: false, code: "exists", path: target, errors: ["skill already exists at path"] };
	}
	try {
		mkdirSync(join(outputDir, document.directoryName), { recursive: true });
		writeFileSync(target, document.markdown, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, code: "error", errors: [`failed to write skill: ${message}`] };
	}
	return { ok: true, path: target };
}

/**
 * Confirm a captured skill is discoverable by the real skill loader and carries
 * no loader diagnostics (i.e. no name/description warnings). This is the
 * non-tautological proof that the generated document is genuinely valid.
 */
export function verifyCapturedSkill(outputDir: string, name: string): VerifyResult {
	const { skills, diagnostics } = loadSkillsFromDir({ dir: outputDir, source: "local" });
	const diagMessages = diagnostics.map((diagnostic) => diagnostic.message);
	const found = skills.find((skill) => skill.name === name);
	if (!found) {
		return { ok: false, errors: ["captured skill not found after capture", ...diagMessages] };
	}
	return {
		ok: true,
		skill: { name: found.name, description: found.description, filePath: found.filePath },
		diagnostics: diagMessages,
	};
}
