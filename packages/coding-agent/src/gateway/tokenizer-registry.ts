/**
 * Provider-keyed tokenizer registry for the session token meter (ADR-0060).
 * Resolves the active provider + model to a real tokenizer so the meter
 * counts tokens the way the provider prices them, instead of the
 * fixed-density heuristic (ADR-0055). gpt-tokenizer is a zero-dependency
 * pure-JS BPE whose vocab tables ship as data modules in the npm package,
 * so counts need no network and no native module; the coding-agent bundle
 * inlines the tables at build time (offline-safe by construction).
 *
 * Registered families:
 * - openai (plus openai-codex and azure-openai-responses): the o200k_base
 *   vocabulary for the modern model families (gpt-4o, gpt-4.1, gpt-4.5,
 *   gpt-5, o1, o3, o4), cl100k_base for the classic families (gpt-4,
 *   gpt-3.5, text-embedding). A model-less resolution defaults to
 *   o200k_base; an unrecognized model id counts on the denser cl100k_base
 *   table so an unknown model can never under-price a session.
 * - deepseek: cl100k_base for every model. DeepSeek publishes no official
 *   tokenizer package; its BPE is a ~100k-vocab GPT-4-shaped family, so
 *   the cl100k_base count is the best available pure-JS approximation.
 *   The choice is stated in ADR-0060.
 *
 * Any other provider falls back to the ADR-0055 heuristic with a console
 * warning, emitted once per unknown provider per process so a gateway
 * message loop cannot spam the log. No provider at all (the meter called
 * without model context) stays on the heuristic silently: the meter is
 * provider-agnostic when nothing is anchored.
 */
import { encode as encodeCl100k } from "gpt-tokenizer/encoding/cl100k_base";
import { encode as encodeO200k } from "gpt-tokenizer/encoding/o200k_base";

/** Fixed text density of the fallback heuristic: one token per N characters. */
export const CHARS_PER_TOKEN = 4;

/** Identity of the tokenizer that produced a count. */
export type TokenizerName = "heuristic" | "gpt-tokenizer/cl100k_base" | "gpt-tokenizer/o200k_base";

/** A deterministic text counter: text in, token count out. */
export interface TextTokenizer {
	readonly name: TokenizerName;
	readonly countText: (text: string) => number;
}

/** A resolved tokenizer plus an optional fallback warning. */
export interface TokenizerResolution {
	readonly tokenizer: TextTokenizer;
	/** Set when the provider is known but unregistered; the count fell back. */
	readonly warning?: string;
}

/** The gpt-tokenizer cl100k_base counter (GPT-4 / GPT-3.5 family BPE). */
const CL100K: TextTokenizer = Object.freeze({
	name: "gpt-tokenizer/cl100k_base",
	countText: (text: string): number => encodeCl100k(text).length,
});

/** The gpt-tokenizer o200k_base counter (GPT-4o / o1 family BPE). */
const O200K: TextTokenizer = Object.freeze({
	name: "gpt-tokenizer/o200k_base",
	countText: (text: string): number => encodeO200k(text).length,
});

/** The ADR-0055 fixed-density heuristic, kept as the honest fallback. */
const HEURISTIC: TextTokenizer = Object.freeze({
	name: "heuristic",
	countText: (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN),
});

/** Modern OpenAI model families that use the o200k_base vocabulary. */
const O200K_MODEL_PREFIX = /^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|o1|o3|o4|chatgpt-4o)/;

/** openai-family selection: modern prefixes on o200k_base, everything else cl100k_base. */
function openAiFamily(model: string | undefined): TextTokenizer {
	// Model-less resolutions get the modern default family; an unrecognized
	// model id counts on the denser classic table so it can never under-price.
	if (model === undefined || O200K_MODEL_PREFIX.test(model)) return O200K;
	return CL100K;
}

/** Provider family (normalized) -> tokenizer selection by model id. */
type FamilySelector = (model: string | undefined) => TextTokenizer;

/** The registered provider families. */
const FAMILIES: ReadonlyMap<string, FamilySelector> = new Map<string, FamilySelector>([
	["openai", openAiFamily],
	["openai-codex", openAiFamily],
	["azure-openai-responses", openAiFamily],
	["deepseek", () => CL100K],
]);

/** Providers that already warned this process (avoid per-message log spam). */
const warnedProviders = new Set<string>();

/** Lowercase-trim a provider or model id; blanks read as "unknown". */
function normalize(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

/**
 * Resolve the tokenizer for a provider + model. A missing provider resolves
 * to the heuristic silently; an unregistered provider resolves to the
 * heuristic with a warning (logged once per provider per process).
 */
export function resolveTokenizer(provider?: string, model?: string): TokenizerResolution {
	const normalizedProvider = normalize(provider);
	if (!normalizedProvider) return { tokenizer: HEURISTIC };
	const selector = FAMILIES.get(normalizedProvider);
	if (!selector) {
		const warning = `no tokenizer registered for provider "${normalizedProvider}"; counting with the fixed-density heuristic`;
		if (!warnedProviders.has(normalizedProvider)) {
			warnedProviders.add(normalizedProvider);
			console.warn(`[session-token-meter] ${warning}`);
		}
		return { tokenizer: HEURISTIC, warning };
	}
	const normalizedModel = normalize(model);
	return { tokenizer: selector(normalizedModel ? normalizedModel : undefined) };
}
