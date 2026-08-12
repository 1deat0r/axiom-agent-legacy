/**
 * `axiom skill-capture-auto` — step 3 of procedural-memory skills: automatic
 * flagging. Reads a completed task trace, decides whether it is reusable
 * (evaluateTaskForCapture), and only then materializes a skill through the
 * ADR-0020 capture pipeline and offers it. `--force` skips the heuristic.
 * Returns true when the invocation was a skill-capture-auto command.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SkillProvenance, TaskCapture, TaskStep, TaskTrace } from "../core/skill-capture/index.js";
import {
	buildSkillDocument,
	CAPTURE_THRESHOLD,
	deriveName,
	evaluateTaskForCapture,
	persistCapturedSkill,
	verifyCapturedSkill,
} from "../core/skill-capture/index.js";

export const SKILL_CAPTURE_AUTO_USAGE =
	"axiom skill-capture-auto <trace.json> [--out <dir>] [--force] [--json] [--name <slug>] [--description <text>] [--source <label>]";

export interface SkillCaptureAutoOptions {
	traceFile: string;
	out: string;
	force: boolean;
	json: boolean;
	name?: string;
	description?: string;
	source?: string;
}

export type SkillCaptureAutoParseResult =
	| { ok: true; options: SkillCaptureAutoOptions }
	| { ok: false; help?: boolean; errors: string[] };

function readVal(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	if (i >= 0 && i + 1 < args.length) {
		const value = args[i + 1];
		if (value && !value.startsWith("--")) return value;
	}
	return undefined;
}

export function parseSkillCaptureAutoArgs(args: string[]): SkillCaptureAutoParseResult {
	if (args.includes("--help") || args.includes("-h")) {
		return { ok: false, help: true, errors: [] };
	}
	const traceFile =
		args.find((arg, index) => index > 0 && !arg.startsWith("--") && !args[index - 1].startsWith("--")) ?? args[1];
	const out = readVal(args, "--out");
	if (!traceFile || traceFile.startsWith("--") || !out) {
		const errors: string[] = [];
		if (!traceFile || traceFile.startsWith("--")) errors.push("<trace.json> is required");
		if (!out) errors.push("--out is required (destination skills directory)");
		return { ok: false, errors };
	}
	return {
		ok: true,
		options: {
			traceFile,
			out,
			force: args.includes("--force"),
			json: args.includes("--json"),
			name: readVal(args, "--name"),
			description: readVal(args, "--description"),
			source: readVal(args, "--source"),
		},
	};
}

export interface SkillTraceFile {
	prompt?: string;
	description?: string;
	steps?: (string | { summary: string; detail?: string })[];
	completed?: boolean;
	sessionId?: string;
	metadata?: Record<string, unknown>;
}

/** Read a trace JSON file into a TaskTrace. Returns a structured error on failure. */
export function readTraceFile(
	path: string,
): { ok: true; trace: TaskTrace; file: SkillTraceFile } | { ok: false; errors: string[] } {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, errors: [`could not read trace file: ${message}`] };
	}
	let file: SkillTraceFile;
	try {
		file = JSON.parse(raw) as SkillTraceFile;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, errors: [`invalid trace file: ${message}`] };
	}
	const steps: TaskStep[] = (file.steps ?? []).map((step) => {
		if (typeof step === "string") return { summary: step };
		return { summary: step.summary, detail: step.detail };
	});
	const trace: TaskTrace = {
		prompt: file.prompt ?? "",
		steps,
		completed: file.completed,
		metadata: file.metadata,
	};
	return { ok: true, trace, file };
}

interface SkillCaptureAutoIo {
	log(message: string): void;
	err(message: string): void;
}

/** Handle `axiom skill-capture-auto ...`; returns true when it was a skill-capture-auto invocation. */
export function handleSkillCaptureAutoCommand(
	args: string[],
	io: SkillCaptureAutoIo = { log: (m) => console.log(m), err: (m) => console.error(m) },
): boolean {
	if (args[0] !== "skill-capture-auto") return false;
	const parsed = parseSkillCaptureAutoArgs(args);
	if (parsed.ok === false && parsed.help) {
		io.log(
			`${SKILL_CAPTURE_AUTO_USAGE}\n\nRead a completed task trace, decide if it is reusable, and only then\nmaterialize a skill. --force captures regardless of the heuristic.`,
		);
		return true;
	}
	if (parsed.ok === false) {
		io.err(parsed.errors.join("\n"));
		return true;
	}
	const { options } = parsed;

	const traceResult = readTraceFile(options.traceFile);
	if (traceResult.ok === false) {
		io.err(traceResult.errors.join("\n"));
		return true;
	}
	const { trace, file } = traceResult;

	const evaluation = evaluateTaskForCapture(trace);
	if (!evaluation.shouldCapture && !options.force) {
		if (options.json) {
			io.log(JSON.stringify({ ok: false, flagged: false, score: evaluation.score, reasons: evaluation.reasons }));
		} else {
			io.log(
				`Task not flagged as reusable (score ${evaluation.score.toFixed(2)} < ${CAPTURE_THRESHOLD}).\n` +
					evaluation.reasons.map((reason) => `  - ${reason}`).join("\n") +
					`\nRe-run with --force to capture anyway.`,
			);
		}
		return true;
	}

	const provenance: SkillProvenance = {
		source: options.source ?? "auto",
		createdAt: new Date().toISOString(),
		...(file.sessionId ? { sessionId: file.sessionId } : {}),
	};
	const capture: TaskCapture = {
		name: options.name ?? deriveName(trace.prompt),
		description:
			options.description ?? file.description ?? `Captured reusable task: ${trace.prompt.trim().slice(0, 140)}`,
		prompt: trace.prompt,
		steps: [...trace.steps],
		provenance,
		metadata: trace.metadata,
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
				flagged: true,
				score: evaluation.score,
				name: verified.skill.name,
				path: persisted.path,
				diagnostics: verified.diagnostics,
			}),
		);
		return true;
	}
	io.log(
		`Flagged reusable (score ${evaluation.score.toFixed(2)}), captured skill "${verified.skill.name}" → ${persisted.path}\n` +
			`Verified: loads with ${verified.diagnostics.length} loader diagnostics. Offer this as a reusable skill.`,
	);
	return true;
}
