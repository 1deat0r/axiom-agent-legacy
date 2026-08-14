/**
 * The Ralph handoff for the `delegate` tool (issue #33).
 *
 * Every helper is asked to end its run with a bounded structured report —
 * status, summary, evidence, next steps, blockers — so a fresh child session
 * can hand its state back to the parent without a transcript (the Ralph loop
 * pattern: a bounded handoff plus a shared workspace carry state between
 * rounds). This module owns the three pieces of that contract:
 *
 * - `buildHelperPrompt` — the prompt the helper receives, which asks for the
 *   handoff as a JSON object at the end of its final reply;
 * - `parseDelegateHandoff` — robust recovery of that JSON (reusing the
 *   battle-tested `extractJsonObject` from core/refinement), normalized and
 *   capped; helpers that emit no handoff simply yield `undefined` and the
 *   old compact result stays the contract;
 * - `capHandoff` + `DEFAULT_HANDOFF_CAPS` — the per-field length limits that
 *   guarantee the handoff stays bounded no matter what the helper returns.
 */

import { extractJsonObject } from "../../core/refinement/index.js";
import type { DelegateHandoff } from "./types.js";

/** Per-field limits for the handoff; every field is capped at parse time. */
export interface DelegateHandoffCaps {
	statusMaxChars: number;
	summaryMaxChars: number;
	evidenceMaxItems: number;
	evidenceItemMaxChars: number;
	nextStepsMaxItems: number;
	nextStepItemMaxChars: number;
	blockersMaxItems: number;
	blockerItemMaxChars: number;
}

/**
 * Default caps. `summaryMaxChars` matches `DEFAULT_SUMMARY_MAX_CHARS` in
 * result.ts so the handoff summary never exceeds the compact result summary
 * (the alignment is pinned by a test).
 */
export const DEFAULT_HANDOFF_CAPS: DelegateHandoffCaps = {
	statusMaxChars: 100,
	summaryMaxChars: 2000,
	evidenceMaxItems: 8,
	evidenceItemMaxChars: 500,
	nextStepsMaxItems: 8,
	nextStepItemMaxChars: 300,
	blockersMaxItems: 8,
	blockerItemMaxChars: 300,
};

/** Trim + length-cap one string; "" for non-positive caps (same semantics as capSummary). */
function capText(text: string, maxChars: number): string {
	if (maxChars <= 0) {
		return "";
	}
	const trimmed = text.trim();
	return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars);
}

/** Cap a list: drop blanks, cap each item, then keep at most maxItems. */
function capItems(items: string[], maxItems: number, maxChars: number): string[] {
	const out: string[] = [];
	for (const item of items) {
		const text = capText(item, maxChars);
		if (text.length === 0) {
			continue;
		}
		if (out.length >= maxItems) {
			break;
		}
		out.push(text);
	}
	return out;
}

/** Normalize a handoff so every field respects its cap (blank items dropped). */
export function capHandoff(
	handoff: DelegateHandoff,
	caps: DelegateHandoffCaps = DEFAULT_HANDOFF_CAPS,
): DelegateHandoff {
	return {
		status: capText(handoff.status, caps.statusMaxChars),
		summary: capText(handoff.summary, caps.summaryMaxChars),
		evidence: capItems(handoff.evidence, caps.evidenceMaxItems, caps.evidenceItemMaxChars),
		nextSteps: capItems(handoff.nextSteps, caps.nextStepsMaxItems, caps.nextStepItemMaxChars),
		blockers: capItems(handoff.blockers, caps.blockersMaxItems, caps.blockerItemMaxChars),
	};
}

/** Accept a raw field as an array of strings or a single string; drop the rest. */
function stringList(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw.filter((item): item is string => typeof item === "string");
	}
	return typeof raw === "string" ? [raw] : [];
}

/**
 * Recover a capped handoff from the helper's final text, or `undefined` when
 * the helper emitted no handoff (the old compact result stays the contract).
 *
 * `extractJsonObject` handles a bare object, a fenced ```json block, and JSON
 * wrapped in prose. Both camelCase and snake_case spellings of the
 * next-steps field are accepted. A JSON object without a non-empty status or
 * summary is not a handoff.
 */
export function parseDelegateHandoff(
	text: string | null | undefined,
	caps: DelegateHandoffCaps = DEFAULT_HANDOFF_CAPS,
): DelegateHandoff | undefined {
	if (typeof text !== "string" || text.trim().length === 0) {
		return undefined;
	}
	let value: unknown;
	try {
		value = extractJsonObject(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const status = typeof record.status === "string" ? record.status.trim() : "";
	const summary = typeof record.summary === "string" ? record.summary.trim() : "";
	if (status.length === 0 && summary.length === 0) {
		return undefined;
	}
	return capHandoff(
		{
			status,
			summary,
			evidence: stringList(record.evidence),
			nextSteps: stringList(record.nextSteps ?? record.next_steps),
			blockers: stringList(record.blockers),
		},
		caps,
	);
}

/**
 * Wrap a task in the helper prompt: the original instruction plus the request
 * for the bounded structured handoff. The bridge sends exactly this text to
 * the helper, so every helper is asked for the handoff (issue #33).
 */
export function buildHelperPrompt(task: string): string {
	return `${task.trim()}

HANDOFF (required): when you finish, end your final reply with a JSON object that reports the result. Use exactly these five fields:
{"status": "<done|partial|blocked|failed>", "summary": "<what happened and what is finished>", "evidence": ["<what you ran, read, or observed>"], "nextSteps": ["<what the parent should do next, in order>"], "blockers": ["<what blocks completion>"]}
Keep each string short. An empty list is fine (for example "blockers": [] when nothing blocks). Put the JSON object last in your reply.`;
}

/** Compact parent-facing rendering of a handoff (status line, then the fields). */
export function renderHandoff(handoff: DelegateHandoff): string {
	const lines = [`[status] ${handoff.status}`, handoff.summary];
	if (handoff.evidence.length > 0) {
		lines.push(`Evidence: ${handoff.evidence.join("; ")}`);
	}
	if (handoff.nextSteps.length > 0) {
		lines.push(`Next: ${handoff.nextSteps.join("; ")}`);
	}
	if (handoff.blockers.length > 0) {
		lines.push(`Blockers: ${handoff.blockers.join("; ")}`);
	}
	return lines.join("\n");
}
