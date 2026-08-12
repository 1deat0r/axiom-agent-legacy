/**
 * `axiom skill-capture` — step 1 of procedural-memory skills: capture a task that
 * was flagged as reusable into a validated, provenance-bearing skill that bundles
 * the task prompt + its ordered steps, then verify it loads via the real skill
 * loader and offer the result. Returns true when the invocation was a
 * skill-capture command.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSkillDocument, persistCapturedSkill, slugify, verifyCapturedSkill } from "../core/skill-capture/index.js";
import type { SkillProvenance, TaskCapture, TaskStep } from "../core/skill-capture/types.js";

export const SKILL_CAPTURE_USAGE =
	"axiom skill-capture --prompt <text> --description <text> --out <dir> [--name <slug>] [--steps-file <json|jsonl>] [--source <label>] [--session-id <id>] [--json]";

export interface SkillCaptureOptions {
	prompt: string;
	description: string;
	out: string;
	name?: string;
	stepsFile?: string;
	source?: string;
	sessionId?: string;
	trigger?: string;
	json?: boolean;
}

export type SkillCaptureParseResult =
	| { ok: true; options: SkillCaptureOptions }
	| { ok: false; help?: boolean; errors: string[] };

function readVal(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	if (i >= 0 && i + 1 < args.length) {
		const value = args[i + 1];
		if (value && !value.startsWith("--")) return value;
	}
	return undefined;
}

export function parseSkillCaptureArgs(args: string[]): SkillCaptureParseResult {
	if (args.includes("--help") || args.includes("-h")) {
		return { ok: false, help: true, errors: [] };
	}
	const prompt = readVal(args, "--prompt");
	const description = readVal(args, "--description");
	const out = readVal(args, "--out");
	if (!prompt || !description || !out) {
		const errors: string[] = [];
		if (!prompt) errors.push("--prompt is required");
		if (!description) errors.push("--description is required");
		if (!out) errors.push("--out is required (destination skills directory)");
		return { ok: false, errors };
	}
	return {
		ok: true,
		options: {
			prompt,
			description,
			out,
			name: readVal(args, "--name"),
			stepsFile: readVal(args, "--steps-file"),
			source: readVal(args, "--source"),
			sessionId: readVal(args, "--session-id"),
			trigger: readVal(args, "--trigger"),
			json: args.includes("--json"),
		},
	};
}

/**
 * Read a steps file: a JSON array of strings or `{summary, detail}` objects, or
 * JSONL of the same. Returns a structured error list on any parse problem.
 */
export function readStepsFile(path: string): { ok: true; steps: TaskStep[] } | { ok: false; errors: string[] } {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, errors: [`could not read steps file: ${message}`] };
	}
	try {
		const data = JSON.parse(raw);
		const items: unknown[] = Array.isArray(data) ? data : [data];
		const steps: TaskStep[] = items.map((item, index) => {
			if (typeof item === "string") {
				return { summary: item };
			}
			if (item && typeof item === "object" && typeof (item as { summary?: unknown }).summary === "string") {
				const obj = item as { summary: string; detail?: unknown };
				return { summary: obj.summary, detail: typeof obj.detail === "string" ? obj.detail : undefined };
			}
			throw new Error(`steps entry ${index} is not a string or {summary, detail}`);
		});
		return { ok: true, steps };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, errors: [`invalid steps file: ${message}`] };
	}
}

export function deriveName(prompt: string): string {
	const short = prompt.trim().slice(0, 60);
	return slugify(short) || "captured-task";
}

interface SkillCaptureIo {
	log(message: string): void;
	err(message: string): void;
}

/** Handle `axiom skill-capture ...`; returns true when it was a skill-capture invocation. */
export function handleSkillCaptureCommand(
	args: string[],
	io: SkillCaptureIo = { log: (m) => console.log(m), err: (m) => console.error(m) },
): boolean {
	if (args[0] !== "skill-capture") return false;
	const parsed = parseSkillCaptureArgs(args);
	if (parsed.ok === false && parsed.help) {
		io.log(
			`${SKILL_CAPTURE_USAGE}\n\nCapture a completed, flagged-reusable task as a validated skill\n(prompt + ordered steps + provenance) and verify it loads via the real skill loader.`,
		);
		return true;
	}
	if (parsed.ok === false) {
		io.err(parsed.errors.join("\n"));
		return true;
	}
	const { options } = parsed;

	let steps: TaskStep[] = [];
	if (options.stepsFile) {
		const stepsResult = readStepsFile(options.stepsFile);
		if (stepsResult.ok === false) {
			io.err(stepsResult.errors.join("\n"));
			return true;
		}
		steps = stepsResult.steps;
	}

	const provenance: SkillProvenance = {
		source: options.source ?? "manual",
		createdAt: new Date().toISOString(),
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		...(options.trigger ? { trigger: options.trigger } : {}),
	};

	const capture: TaskCapture = {
		name: options.name ?? deriveName(options.prompt),
		description: options.description,
		prompt: options.prompt,
		steps,
		provenance,
	};

	const built = buildSkillDocument(capture);
	if (built.ok === false) {
		io.err(`skill validation failed:\n${built.errors.join("\n")}`);
		return true;
	}

	const persisted = persistCapturedSkill(resolve(options.out), built.document);
	if (persisted.ok === false) {
		if (persisted.code === "exists") {
			io.err(`refusing to overwrite existing skill at ${persisted.path}`);
		} else {
			io.err(persisted.errors.join("\n"));
		}
		return true;
	}

	const verified = verifyCapturedSkill(resolve(options.out), built.document.name);
	if (verified.ok === false) {
		io.err(`captured skill failed verification:\n${verified.errors.join("\n")}`);
		return true;
	}

	if (options.json) {
		io.log(
			JSON.stringify({
				ok: true,
				name: verified.skill.name,
				description: verified.skill.description,
				path: persisted.path,
				diagnostics: verified.diagnostics,
			}),
		);
		return true;
	}

	io.log(
		`Captured reusable skill "${verified.skill.name}" → ${persisted.path}\n` +
			`Verified: loads with ${verified.diagnostics.length} loader diagnostics.\n` +
			`Offer this to the user as a reusable skill; install it by copying the '${built.document.name}' directory into a skills directory.`,
	);
	return true;
}
