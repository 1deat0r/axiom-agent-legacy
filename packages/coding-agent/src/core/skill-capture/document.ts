import { stringify as stringifyYaml } from "yaml";
import { MAX_NAME_LENGTH, validateDescription, validateName } from "../skills.js";
import type { CapturedSkillDocument, CaptureValidationResult, TaskCapture } from "./types.js";

/**
 * Turn a suggested name into a valid Agent Skills name: lowercase a-z0-9 with
 * single hyphen separators, bounded by MAX_NAME_LENGTH. Non-conforming input is
 * reduced to this alphabet rather than rejected, so a title like
 * "Deploy the Lambda!" becomes "deploy-the-lambda".
 */
export function slugify(name: string): string {
	const lower = name.trim().toLowerCase();
	const dashed = lower.replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-");
	const trimmed = dashed.replace(/^-+|-+$/g, "");
	return trimmed.slice(0, MAX_NAME_LENGTH);
}

/**
 * Render a validated skill document from a task capture. Validation mirrors the
 * loader's own rules (`validateName`/`validateDescription` from skills.ts) so a
 * generated document can never be silently dropped by the loader.
 */
export function buildSkillDocument(capture: TaskCapture): CaptureValidationResult {
	const errors: string[] = [];

	if (!capture.prompt || capture.prompt.trim() === "") {
		errors.push("prompt is required");
	}
	if (!capture.provenance || !capture.provenance.source || capture.provenance.source.trim() === "") {
		errors.push("provenance.source is required");
	}
	if (!capture.provenance.createdAt || capture.provenance.createdAt.trim() === "") {
		errors.push("provenance.createdAt is required");
	}

	const name = slugify(capture.name);
	if (!name) {
		errors.push("name is required (produced an empty slug)");
	}
	errors.push(...validateName(name, name));

	const description = capture.description?.trim() ?? "";
	errors.push(...validateDescription(description));

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	const metadata: Record<string, unknown> = {
		...capture.metadata,
		provenance: {
			source: capture.provenance.source,
			createdAt: capture.provenance.createdAt,
			...(capture.provenance.sessionId ? { sessionId: capture.provenance.sessionId } : {}),
			...(capture.provenance.trigger ? { trigger: capture.provenance.trigger } : {}),
		},
	};

	const frontmatterObj: Record<string, unknown> = {
		name,
		description,
		metadata,
		...capture.extraFrontmatter,
	};
	const frontmatter = `---\n${stringifyYaml(frontmatterObj)}---`;

	const heading = capture.name.trim() || name;
	const body = `# ${heading}

${description}

## Task

${capture.prompt.trim()}

## Steps

${capture.steps
	.map((step, index) => {
		const detail = step.detail?.trim() ? `\n\n${step.detail.trim()}` : "";
		return `${index + 1}. ${step.summary.trim()}${detail}`;
	})
	.join("\n")}

## Provenance

Captured as a reusable skill from \`${capture.provenance.source}\` on ${capture.provenance.createdAt}.${
		capture.provenance.sessionId ? ` Session: \`${capture.provenance.sessionId}\`.` : ""
	}`;

	const markdown = `${frontmatter}\n\n${body}\n`;

	const document: CapturedSkillDocument = {
		name,
		description,
		frontmatter,
		markdown,
		directoryName: name,
	};
	return { ok: true, document };
}
