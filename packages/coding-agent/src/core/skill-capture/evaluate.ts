import type { TaskStep } from "./types.js";

/**
 * Automatic flagging — step 3 of the procedural-memory skills feature.
 *
 * Given a trace of a completed task, decide whether it is likely reusable enough
 * to warrant capturing it into a skill (before materializing it via the
 * ADR-0020 pipeline). This is a deterministic heuristic, not a model judgment:
 * it rewards task complexity/structure and generic-reuse signals, and penalizes
 * incompleteness and one-off phrasing. The threshold and weights are kept
 * explicit and tunable so operator feedback can adjust sensitivity.
 */

export const REUSABLE_SIGNALS = [
	"reusable",
	"reuse",
	"generalize",
	"template",
	"pattern",
	"every time",
	"each time",
	"common",
	"frequently",
	"repeat",
	"best practice",
	"red-green",
] as const;

export const ONE_OFF_SIGNALS = [
	"one-time",
	"one off",
	"oneoff",
	"once",
	"throwaway",
	"scratch",
	"ad hoc",
	"temporary",
	"this particular",
] as const;

/** Minimum step count before a task is considered structurally reusable. */
export const MIN_REUSABLE_STEPS = 2;

/** Score at or above which a completed task is flagged for capture. */
export const CAPTURE_THRESHOLD = 0.55;

export interface TaskTrace {
	/** The task's original prompt/request. */
	prompt: string;
	/** The ordered steps taken. */
	steps: readonly TaskStep[];
	/** Whether the task reached a completed state (default true). */
	completed?: boolean;
	/** Optional free-form metadata (e.g. session id). */
	metadata?: Record<string, unknown>;
}

export interface CaptureEvaluation {
	shouldCapture: boolean;
	/** Normalized 0..1 score. */
	score: number;
	/** Human-readable reasons for the decision. */
	reasons: string[];
}

const has = (text: string, signals: readonly string[]): string | undefined =>
	signals.find((signal) => text.toLowerCase().includes(signal));

export function evaluateTaskForCapture(trace: TaskTrace): CaptureEvaluation {
	const reasons: string[] = [];
	const text = `${trace.prompt ?? ""} ${trace.steps.map((step) => step.summary).join(" ")}`.toLowerCase();
	const stepCount = trace.steps.length;
	const completed = trace.completed !== false;

	const complexity = Math.min(stepCount / 6, 1) * 0.5;
	if (stepCount >= MIN_REUSABLE_STEPS) {
		reasons.push(`multi-step (${stepCount} steps)`);
	} else {
		reasons.push(`only ${stepCount} step(s) — too thin to generalize`);
	}

	const reusableSignal = has(text, REUSABLE_SIGNALS);
	const oneOffSignal = has(text, ONE_OFF_SIGNALS);
	if (reusableSignal) reasons.push(`reusable signal: "${reusableSignal}"`);
	if (oneOffSignal) reasons.push(`one-off signal: "${oneOffSignal}"`);

	const completionBonus = completed ? 0.15 : -0.25;
	if (!completed) reasons.push("task not marked complete");

	const thinPenalty = stepCount < MIN_REUSABLE_STEPS ? -0.3 : 0;

	const score = Math.max(
		0,
		Math.min(1, complexity + (reusableSignal ? 0.3 : 0) + (oneOffSignal ? -0.35 : 0) + completionBonus + thinPenalty),
	);

	const shouldCapture = completed && score >= CAPTURE_THRESHOLD;
	reasons.push(`score ${score.toFixed(2)} ${shouldCapture ? ">=" : "<"} threshold ${CAPTURE_THRESHOLD}`);
	return { shouldCapture, score, reasons };
}
