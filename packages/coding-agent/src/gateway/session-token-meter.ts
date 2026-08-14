/**
 * Gateway session token meter (ADR-0055, extended by ADR-0060): measures
 * the model-facing surface of a channel session as a token count, so
 * pre-run compaction triggers on token pressure instead of file bytes. The
 * 508k-token session incident (ADR-0041) showed why: the byte budget is a
 * weak proxy for prefill cost, and a big-window model never fires
 * auto-compaction.
 *
 * Since ADR-0060 the meter resolves a real tokenizer per provider/model
 * family (gpt-tokenizer for openai and deepseek; see tokenizer-registry.ts)
 * so counts match provider pricing. Providers without a registered
 * tokenizer fall back to the ADR-0055 fixed-density heuristic (one token
 * per CHARS_PER_TOKEN characters plus structural overhead per content
 * block and per message role) with a warning recorded on the snapshot.
 * The byte budget (session-reset.ts) stays as the safety limit for
 * sessions the meter prices low.
 */
import { existsSync, readFileSync } from "node:fs";
import type { TextTokenizer, TokenizerName } from "./tokenizer-registry.js";
import { CHARS_PER_TOKEN, resolveTokenizer } from "./tokenizer-registry.js";

export { CHARS_PER_TOKEN };

/** Per-block structural overhead for JSON framing and type tags. */
export const BLOCK_OVERHEAD = 4;

/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4;

/**
 * Soft cap on surface tokens before a run requests compaction. 48k tokens
 * is roughly a 190KB session of pure text - the prefill pressure where
 * big-window models start feeling slow. The 256KB byte budget (ADR-0041)
 * stays as the safety limit for sessions the meter prices low.
 */
export const GATEWAY_SESSION_TOKEN_BUDGET = 48 * 1024;

/**
 * Tokenizer context for a measurement. Every field is optional: no context
 * measures under the heuristic (the ADR-0055 behavior, unchanged).
 */
export interface TokenMeterOptions {
	/** Provider id of the active model; drives tokenizer selection. */
	readonly provider?: string;
	/** Active model id; refines tokenizer selection within a provider family. */
	readonly model?: string;
	/** Explicit tokenizer override; wins over provider/model resolution. */
	readonly tokenizer?: TextTokenizer;
}

/** One detached, immutable measurement of the session surface. */
export interface TokenMeterSnapshot {
	/** JSONL entries consumed from the session file when the snapshot was taken. */
	readonly revision: number;
	/** Identity of the tokenizer that produced the count. */
	readonly estimator: TokenizerName;
	/** Text density the estimator used (present for heuristic counts only). */
	readonly charsPerToken?: number;
	/** Set when the requested provider is unregistered and the count fell back. */
	readonly fallbackWarning?: string;
	/** Tokens across the model-facing message surface. */
	readonly surfaceTokens: number;
	/** Message entries priced into surfaceTokens. */
	readonly pricedMessages: number;
	/** Unparseable lines skipped while reading (the revision still advances). */
	readonly malformedEntries: number;
}

/** One model-visible content block; fields are unknown until priced. */
interface ContentBlockShape {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	arguments?: unknown;
	content?: unknown;
}

/** One session message entry (role, content blocks, toolName for results). */
interface SessionMessageShape {
	role?: unknown;
	content?: unknown;
	toolName?: unknown;
}

/** One parsed JSONL entry from the session file. */
interface SessionEntryShape {
	type?: unknown;
	message?: unknown;
}

/** A resolved text counter plus the snapshot fields it produces. */
interface ResolvedCounter {
	counter: (text: string) => number;
	estimator: TokenizerName;
	charsPerToken: number | undefined;
	fallbackWarning: string | undefined;
}

/** Heuristic tokens for a string: ceil(length / density). */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Price content blocks recursively under the given text counter (the
 * fixed-density heuristic by default). Unknown block types fall back to a
 * conservative JSON price, so a new provider block shape can never read as
 * free surface.
 */
export function estimateContentTokens(
	blocks: readonly unknown[],
	countText: (text: string) => number = estimateTextTokens,
): number {
	let tokens = 0;
	for (const raw of blocks) {
		if (raw === null || typeof raw !== "object") {
			tokens += BLOCK_OVERHEAD + countText(JSON.stringify(raw));
			continue;
		}
		const block = raw as ContentBlockShape;
		switch (block.type) {
			case "text": {
				const text = block.text;
				tokens += BLOCK_OVERHEAD + countText(typeof text === "string" ? text : JSON.stringify(text ?? ""));
				break;
			}
			case "thinking": {
				const thinking = block.thinking;
				tokens +=
					BLOCK_OVERHEAD + countText(typeof thinking === "string" ? thinking : JSON.stringify(thinking ?? ""));
				break;
			}
			case "toolCall": {
				const name = block.name;
				const args = block.arguments;
				const argsText = typeof args === "string" ? args : JSON.stringify(args ?? "");
				tokens += BLOCK_OVERHEAD + countText(typeof name === "string" ? name : "") + countText(argsText);
				break;
			}
			case "toolResult": {
				const name = block.name;
				const nested = Array.isArray(block.content) ? block.content : [];
				tokens +=
					BLOCK_OVERHEAD +
					countText(typeof name === "string" ? name : "") +
					estimateContentTokens(nested, countText);
				break;
			}
			default:
				// Merge-extensible: unknown blocks retain a conservative JSON price.
				tokens += BLOCK_OVERHEAD + countText(JSON.stringify(block));
		}
	}
	return tokens;
}

/**
 * Price one model-visible message under the given text counter: content
 * blocks plus the role framing. toolResult messages also carry their tool
 * name; the toolCallId is covered by the block overhead.
 */
export function estimateMessageTokens(
	message: SessionMessageShape,
	countText: (text: string) => number = estimateTextTokens,
): number {
	const content = Array.isArray(message.content) ? message.content : [];
	let tokens = estimateContentTokens(content, countText) + ROLE_OVERHEAD;
	if (message.role === "toolResult") {
		const name = message.toolName;
		tokens += BLOCK_OVERHEAD + countText(typeof name === "string" ? name : "");
	}
	return tokens;
}

/** Resolve the counting context for a measurement (heuristic by default). */
function resolveCounter(options: TokenMeterOptions | undefined): ResolvedCounter {
	const resolution = options?.tokenizer
		? { tokenizer: options.tokenizer, warning: undefined }
		: resolveTokenizer(options?.provider, options?.model);
	const { tokenizer } = resolution;
	return {
		counter: tokenizer.countText,
		estimator: tokenizer.name,
		charsPerToken: tokenizer.name === "heuristic" ? CHARS_PER_TOKEN : undefined,
		fallbackWarning: resolution.warning,
	};
}

/** A frozen zero snapshot for missing or unreadable files (revision 0). */
function emptySnapshot(options?: TokenMeterOptions): TokenMeterSnapshot {
	const resolved = resolveCounter(options);
	return Object.freeze<TokenMeterSnapshot>({
		revision: 0,
		estimator: resolved.estimator,
		charsPerToken: resolved.charsPerToken,
		fallbackWarning: resolved.fallbackWarning,
		surfaceTokens: 0,
		pricedMessages: 0,
		malformedEntries: 0,
	});
}

/**
 * Measure the model-facing surface of a session file: read the JSONL once,
 * price every message entry under the resolved tokenizer (or the
 * heuristic when no tokenizer context is given), and return a detached,
 * frozen snapshot. The revision is the number of entries consumed;
 * unparseable lines are skipped (and counted) so a bad line can never block
 * a measurement. Missing or unreadable files measure as zero - the check
 * must never block a reply, and the byte budget remains the safety limit.
 */
export function measureSessionTokens(path: string, options?: TokenMeterOptions): TokenMeterSnapshot {
	const resolved = resolveCounter(options);
	if (!existsSync(path)) return emptySnapshot(options);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return emptySnapshot(options);
	}
	const lines = text.split("\n");
	// A trailing newline produces one empty final piece - not an entry.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	let surfaceTokens = 0;
	let pricedMessages = 0;
	let malformedEntries = 0;
	for (const line of lines) {
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			malformedEntries += 1;
			continue;
		}
		if (entry === null || typeof entry !== "object") continue;
		const sessionEntry = entry as SessionEntryShape;
		if (sessionEntry.type !== "message") continue;
		const message = sessionEntry.message;
		if (message === null || typeof message !== "object") continue;
		surfaceTokens += estimateMessageTokens(message as SessionMessageShape, resolved.counter);
		pricedMessages += 1;
	}
	return Object.freeze<TokenMeterSnapshot>({
		revision: lines.length,
		estimator: resolved.estimator,
		charsPerToken: resolved.charsPerToken,
		fallbackWarning: resolved.fallbackWarning,
		surfaceTokens,
		pricedMessages,
		malformedEntries,
	});
}

/** Whether a snapshot's surface token count exceeds the budget. */
export function exceedsTokenBudget(snapshot: TokenMeterSnapshot, budget: number): boolean {
	return snapshot.surfaceTokens > budget;
}

/**
 * Whether the session file's model-facing surface exceeds the token budget.
 * Missing or unreadable files read as within budget, so the check can never
 * block a reply (the byte budget remains the safety limit).
 */
export function sessionExceedsTokenBudget(
	path: string,
	budget: number = GATEWAY_SESSION_TOKEN_BUDGET,
	options?: TokenMeterOptions,
): boolean {
	return exceedsTokenBudget(measureSessionTokens(path, options), budget);
}
