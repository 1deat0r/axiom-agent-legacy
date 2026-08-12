/**
 * Pure result-block logic for the `delegate` tool.
 *
 * Kept free of IO and RPC so it is deterministically unit-testable: capping
 * the summary is the mechanism that guarantees the compact block never grows
 * into (or pastes) a helper transcript, and the ok/error shaping is what the
 * parent actually receives.
 */

import type { DelegateResult, DelegateTokenAccounting } from "./types.js";

/** Default cap for the returned summary (compactness guarantee). */
export const DEFAULT_SUMMARY_MAX_CHARS = 2000;

/** Fallback when the helper finished without a textual closing answer. */
export const NO_SUMMARY_TEXT = "(no textual summary captured)";

/** Clamp a raw summary to `maxChars`, trimmed; returns "" for non-positive caps. */
export function capSummary(text: string, maxChars: number = DEFAULT_SUMMARY_MAX_CHARS): string {
	if (maxChars <= 0) {
		return "";
	}
	const trimmed = text.trim();
	return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars);
}

/** A zeroed accounting shape (used when the helper recorded no usage). */
export function emptyAccounting(): DelegateTokenAccounting {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

/** Map a missing/blank closing answer to the documented fallback string. */
export function summaryOrFallback(text: string | null | undefined): string {
	if (typeof text !== "string") {
		return NO_SUMMARY_TEXT;
	}
	const trimmed = text.trim();
	return trimmed.length === 0 ? NO_SUMMARY_TEXT : trimmed;
}

/** Raw inputs from the helper; shaped into the compact block returned to the parent. */
export interface DelegateResultInput {
	ok: boolean;
	summary?: string | null | undefined;
	tokens?: DelegateTokenAccounting | null | undefined;
	cost?: number | null | undefined;
	helper?: { name?: string; model?: string; sessionId?: string };
	error?: string | null | undefined;
}

/**
 * Build the compact `DelegateResult` for the parent session. Only the shape
 * defined here ever leaves the tool — the helper's raw messages are never
 * attached, and the summary is length-capped.
 */
export function toDelegateResult(
	input: DelegateResultInput,
	maxChars: number = DEFAULT_SUMMARY_MAX_CHARS,
): DelegateResult {
	const tokens: DelegateTokenAccounting = input.tokens ?? emptyAccounting();
	const base: DelegateResult = {
		ok: input.ok,
		summary: input.ok ? capSummary(summaryOrFallback(input.summary), maxChars) : "",
		tokens,
		cost: typeof input.cost === "number" ? input.cost : 0,
	};
	if (input.helper) {
		base.helper = input.helper;
	}
	if (!input.ok) {
		base.error = input.error?.trim() || "delegate failed";
	}
	return base;
}

/** Short, low-friction rendering of the block for the parent's model view. */
export function renderDelegateResult(result: DelegateResult): string {
	if (!result.ok) {
		return `[delegate failed] ${result.error ?? "unknown error"}`;
	}
	return `[delegate ok] ${result.tokens.total} tokens, $${result.cost.toFixed(4)}\n${result.summary}`;
}
