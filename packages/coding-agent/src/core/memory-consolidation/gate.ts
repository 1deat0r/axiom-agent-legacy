/**
 * The deterministic durability gate — the sibling of skill-capture's
 * auto-flagging heuristic (ADR-0026). The model proposes facts; this module
 * decides which survive to be staged or applied. Deliberately deterministic
 * and conservative: length bounds, transient/session-scoped phrasing signals,
 * and deduplication against existing harness memory (and within the proposal).
 *
 * Rejected facts carry human-readable reasons so the audit trail explains
 * every decision without needing the model's judgment re-read.
 */

import type { GateResult, MemoryFact, MemoryOverviewEntry } from "./types.js";

export const MIN_TITLE_LENGTH = 3;
export const MAX_TITLE_LENGTH = 120;
export const MIN_CONTENT_LENGTH = 20;
export const MAX_CONTENT_LENGTH = 500;

/**
 * Signals that a fact is about the current session/run rather than durable
 * knowledge. Phrase boundaries are word-boundary matched, so "todo" does not
 * match "todos" and "currently" does not match "current state of the codebase".
 */
export const TRANSIENT_SIGNALS = [
	"this session",
	"this run",
	"this conversation",
	"this chat",
	"right now",
	"currently",
	"in progress",
	"todo",
	"to-do",
	"next step",
	"next turn",
	"we just",
	"just now",
	"today we",
	"today i",
	"still working",
	"left off",
	"for now",
	"temporary",
	"scratch",
	"not yet",
	"not finished",
	"not done",
	"remember to",
] as const;

const transientPatterns: RegExp[] = TRANSIENT_SIGNALS.map(
	(signal) => new RegExp(`\\b${signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
);

export function hasTransientSignal(text: string): string | undefined {
	for (let index = 0; index < TRANSIENT_SIGNALS.length; index += 1) {
		if (transientPatterns[index]?.test(text)) {
			return TRANSIENT_SIGNALS[index];
		}
	}
	return undefined;
}

/** Case-folded, whitespace-collapsed key for duplicate detection. */
export function normalizedKey(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface EvaluateMemoryFactsOptions {
	/** Existing harness memory to dedupe against (id, title, content). */
	existing?: readonly MemoryOverviewEntry[];
	/** Overridable bounds so tuning tests stay cheap (defaults above). */
	minTitleLength?: number;
	maxTitleLength?: number;
	minContentLength?: number;
	maxContentLength?: number;
}

export function evaluateMemoryFacts(
	proposed: readonly MemoryFact[],
	options: EvaluateMemoryFactsOptions = {},
): GateResult {
	const minTitleLength = options.minTitleLength ?? MIN_TITLE_LENGTH;
	const maxTitleLength = options.maxTitleLength ?? MAX_TITLE_LENGTH;
	const minContentLength = options.minContentLength ?? MIN_CONTENT_LENGTH;
	const maxContentLength = options.maxContentLength ?? MAX_CONTENT_LENGTH;

	const existing = options.existing ?? [];
	const seenContent = new Set<string>();
	const seenTitle = new Set<string>();

	const accepted: MemoryFact[] = [];
	const rejected: GateResult["rejected"] = [];

	for (const fact of proposed) {
		const reasons: string[] = [];
		const title = fact.title.trim();
		const content = fact.content.trim();
		const contentKey = normalizedKey(content);
		const titleKey = normalizedKey(title);

		if (title.length < minTitleLength) {
			reasons.push(`title too short (${title.length} < ${minTitleLength} chars)`);
		} else if (title.length > maxTitleLength) {
			reasons.push(`title too long (${title.length} > ${maxTitleLength} chars)`);
		}
		if (content.length < minContentLength) {
			reasons.push(`content too thin (${content.length} < ${minContentLength} chars)`);
		} else if (content.length > maxContentLength) {
			reasons.push(`content too long (${content.length} > ${maxContentLength} chars)`);
		}

		if (reasons.length === 0) {
			const transient = hasTransientSignal(`${title} ${content}`);
			if (transient) {
				reasons.push(`transient signal "${transient}" — fact looks session-scoped`);
			}
		}

		if (reasons.length === 0) {
			const duplicate = [...existing].find((entry) => {
				const entryContent = normalizedKey(entry.content);
				const entryTitle = normalizedKey(entry.title);
				return entryContent !== "" && (entryContent === contentKey || entryTitle === titleKey);
			});
			if (duplicate) {
				reasons.push(`duplicate of existing harness memory "${duplicate.id}"`);
			}
		}

		if (reasons.length === 0 && (seenContent.has(contentKey) || seenTitle.has(titleKey))) {
			reasons.push("duplicate of an earlier fact in this proposal");
		}

		if (reasons.length === 0) {
			seenContent.add(contentKey);
			seenTitle.add(titleKey);
			accepted.push({ title, content, ...(fact.path ? { path: fact.path } : {}) });
		} else {
			rejected.push({ fact, reasons });
		}
	}

	return { accepted, rejected };
}
