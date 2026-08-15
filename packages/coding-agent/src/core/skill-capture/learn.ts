/**
 * /learn — the public on-demand front-end for the skill-capture pipeline
 * (ADR-0080, issue #54). Where the ADR-0027 hook captures silently by
 * default (only when enabled), /learn acts only when the user asks: it builds
 * a task trace from the current session, runs the ADR-0026 flagging
 * heuristic, and materializes a provenance-bearing, loader-verified skill
 * through the ADR-0024 pipeline. Captured skills are staged into the capture
 * directory and offered — installing them into a live skills directory is the
 * ownership lattice's job (issue #55).
 */
import { mkdirSync } from "node:fs";
import { persistCapturedSkill, verifyCapturedSkill } from "./capture.js";
import { buildSkillDocument, deriveName } from "./document.js";
import type { TaskTrace } from "./evaluate.js";
import { evaluateTaskForCapture } from "./evaluate.js";
import type { SkillProvenance, TaskCapture } from "./types.js";

/** Parsed /learn arguments: the only accepted form is `--force`. */
export interface LearnCommandOptions {
	force: boolean;
}

/** Parse "/learn [--force]"; throws a usage error on anything else. */
export function parseLearnCommandOptions(args: string): LearnCommandOptions {
	const trimmed = args.trim();
	if (trimmed === "") return { force: false };
	if (trimmed === "--force") return { force: true };
	throw new Error("Usage: /learn [--force]");
}

/**
 * Build a /learn task capture from a session trace. Provenance records that
 * this capture came from the user-invoked /learn command (source "learn",
 * trigger "/learn"), carrying the session id when the trace provides one.
 */
export function buildLearnCapture(trace: TaskTrace, now: () => Date = () => new Date()): TaskCapture {
	const provenance: SkillProvenance = {
		source: "learn",
		createdAt: now().toISOString(),
		trigger: "/learn",
		...(trace.metadata?.sessionId !== undefined ? { sessionId: String(trace.metadata.sessionId) } : {}),
	};
	return {
		name: deriveName(trace.prompt),
		description: `Captured reusable task: ${trace.prompt.trim().slice(0, 140)}`,
		prompt: trace.prompt,
		steps: [...trace.steps],
		provenance,
		metadata: trace.metadata,
	};
}

/** Injectable pieces so callers/tests can isolate one concern. */
export interface LearnCaptureDeps {
	/** Directory to write captured skills into. */
	captureDir: string;
	/** Capture even when the heuristic does not flag the trace. */
	force?: boolean;
	/** Override the capture document (defaults to buildLearnCapture(trace)). */
	capture?: TaskCapture;
	/** Clock for provenance timestamps. */
	now?: () => Date;
}

export type LearnCaptureResult =
	| { kind: "not-flagged"; score: number; reasons: string[] }
	| { kind: "invalid"; errors: string[] }
	| { kind: "exists"; path: string }
	| { kind: "error"; errors: string[] }
	| { kind: "unverified"; errors: string[] }
	| { kind: "captured"; name: string; description: string; path: string; diagnostics: string[] };

/**
 * Drive the skill-capture pipeline for /learn: evaluate, then build, persist,
 * and verify with the real loader. Nothing is written when the heuristic
 * rejects an unforced capture.
 */
export function runLearnCapture(trace: TaskTrace, deps: LearnCaptureDeps): LearnCaptureResult {
	const evaluation = evaluateTaskForCapture(trace);
	if (!evaluation.shouldCapture && !deps.force) {
		return { kind: "not-flagged", score: evaluation.score, reasons: evaluation.reasons };
	}
	const capture = deps.capture ?? buildLearnCapture(trace, deps.now);
	const built = buildSkillDocument(capture);
	if (!built.ok) {
		return { kind: "invalid", errors: built.errors };
	}
	try {
		mkdirSync(deps.captureDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { kind: "error", errors: [`failed to create capture directory: ${message}`] };
	}
	const persisted = persistCapturedSkill(deps.captureDir, built.document);
	if (!persisted.ok) {
		if (persisted.code === "exists") return { kind: "exists", path: persisted.path };
		return { kind: "error", errors: persisted.errors };
	}
	const verified = verifyCapturedSkill(deps.captureDir, built.document.name);
	if (!verified.ok) {
		return { kind: "unverified", errors: verified.errors };
	}
	return {
		kind: "captured",
		name: verified.skill.name,
		description: verified.skill.description,
		path: persisted.path,
		diagnostics: verified.diagnostics,
	};
}
