import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { fetchPinned, type GateFn, type PinnedFetcher } from "../../extensions/security/fetch-pinned.js";
import type { UrlSafetyOptions } from "../../extensions/security/url.js";
import type { ToolDefinition } from "../extensions/types.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { obscuraSearch } from "./web-mcp-obscura.js";
import {
	axiomUserAgent,
	DEFAULT_MAX_RESULTS,
	DEFAULT_SEARCH_TIMEOUT_MS,
	DEFAULT_SNIPPET_CAP,
	decodeHtmlEntities,
	EngineRateLimiter,
	MAX_RESULTS,
	MAX_SEARCH_BLOCK_CHARS,
	MIN_ENGINE_GAP_MS,
	makeTimedPinnedFetcher,
	resolveNumberEnv,
	SEARCH_ENGINE_HOSTS,
	SEARCH_ENGINE_URLS,
	stripTagsInline,
	type WebSearchEngineName,
} from "./web-shared.js";

export interface RawSearchResult {
	title: string;
	url: string;
	snippet: string;
	date?: string;
}

export interface SearchResult extends RawSearchResult {
	rank: number;
}

export type SearchEngineFn = (engine: WebSearchEngineName, query: string) => Promise<RawSearchResult[]>;
export type FallbackSearchFn = (query: string, numResults: number) => Promise<RawSearchResult[] | null>;

export interface WebSearchOperations {
	searchEngine: SearchEngineFn;
	fallbackSearch: FallbackSearchFn;
}

export interface WebSearchToolOptions {
	operations?: Partial<WebSearchOperations>;
	timeoutMs?: number;
	maxResults?: number;
	rateLimiter?: EngineRateLimiter;
	gate?: GateFn;
	fetcher?: PinnedFetcher;
	gateOptions?: UrlSafetyOptions;
}

/** Unwrap DuckDuckGo redirect wrappers (//duckduckgo.com/l/?uddg=<target>). */
export function unwrapDdgUrl(url: string): string {
	if (!url.includes("duckduckgo.com/l/?")) {
		return url;
	}
	const match = url.match(/[?&]uddg=([^&]+)/);
	if (!match) {
		return url;
	}
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return url;
	}
}

/** Parse DuckDuckGo html-endpoint markup. The anomaly challenge page yields nothing. */
export function parseDdgHtml(html: string): RawSearchResult[] {
	if (html.includes("anomaly.js")) {
		return [];
	}
	const anchorRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const out: RawSearchResult[] = [];
	let match = anchorRe.exec(html);
	while (match !== null) {
		const url = unwrapDdgUrl(decodeHtmlEntities(match[1]));
		const title = decodeHtmlEntities(stripTagsInline(match[2]));
		if (url && title) {
			const windowText = html.slice(anchorRe.lastIndex, anchorRe.lastIndex + 6000);
			const snippetMatch = windowText.match(/<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\//i);
			out.push({ title, url, snippet: snippetMatch ? decodeHtmlEntities(stripTagsInline(snippetMatch[1])) : "" });
		}
		match = anchorRe.exec(html);
	}
	return out;
}

/** Parse Bing result-page markup (li.b_algo blocks). */
export function parseBingHtml(html: string): RawSearchResult[] {
	const START = '<li class="b_algo"';
	const out: RawSearchResult[] = [];
	for (const raw of html.split(START).slice(1)) {
		const listEnd = raw.indexOf("</ol>");
		const block = listEnd === -1 ? raw : raw.slice(0, listEnd);
		const anchor =
			block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ??
			block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
		if (!anchor) {
			continue;
		}
		const url = decodeHtmlEntities(anchor[1]);
		const title = decodeHtmlEntities(stripTagsInline(anchor[2]));
		if (!url || !title) {
			continue;
		}
		const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
		out.push({ title, url, snippet: snippetMatch ? decodeHtmlEntities(stripTagsInline(snippetMatch[1])) : "" });
	}
	return out;
}

/** Dedupe by url, cap snippets and count, assign ranks. */
export function normalizeSearchResults(input: RawSearchResult[], maxResults: number): SearchResult[] {
	const seen = new Set<string>();
	const out: SearchResult[] = [];
	for (const r of input) {
		if (out.length >= maxResults) {
			break;
		}
		if (!r.url || !r.title) {
			continue;
		}
		const url = r.url.trim();
		if (seen.has(url)) {
			continue;
		}
		seen.add(url);
		const snippet = r.snippet.length > DEFAULT_SNIPPET_CAP ? r.snippet.slice(0, DEFAULT_SNIPPET_CAP) : r.snippet;
		out.push({ title: r.title, url, snippet, ...(r.date ? { date: r.date } : {}), rank: out.length + 1 });
	}
	return out;
}

/** Serialize results into one compact JSON block under the total char budget. */
export function buildSearchBlock(results: SearchResult[], maxTotalChars: number = MAX_SEARCH_BLOCK_CHARS): string {
	const parts: string[] = [];
	let total = 0;
	for (const r of results) {
		const item = JSON.stringify(r);
		if (total + item.length + (parts.length > 0 ? 1 : 0) > maxTotalChars) {
			break;
		}
		parts.push(item);
		total += item.length + (parts.length > 1 ? 1 : 0);
	}
	return `[${parts.join(",")}]`;
}

function defaultSearchEngineOps(options?: WebSearchToolOptions): SearchEngineFn {
	const timeoutMs = options?.timeoutMs ?? resolveNumberEnv("AXIOM_WEBSEARCH_TIMEOUT_MS", DEFAULT_SEARCH_TIMEOUT_MS);
	const fetcher =
		options?.fetcher ?? makeTimedPinnedFetcher(timeoutMs, { "user-agent": axiomUserAgent(), accept: "text/html" });
	return async (engine, query) => {
		const url = SEARCH_ENGINE_URLS[engine](query);
		const res = await fetchPinned(url, { fetcher, gate: options?.gate, ...(options?.gateOptions ?? {}) });
		const html = await res.text();
		return engine === "duckduckgo" ? parseDdgHtml(html) : parseBingHtml(html);
	};
}

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	numResults: Type.Optional(
		Type.Number({ description: `Number of results to return (1-${MAX_RESULTS}, default ${DEFAULT_MAX_RESULTS})` }),
	),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchToolDetails {
	query: string;
	engine: WebSearchEngineName | "obscura";
	count: number;
	cached: boolean;
	truncated: boolean;
}

export function createWebSearchToolDefinition(
	_cwd: string,
	options?: WebSearchToolOptions,
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails | undefined> {
	const ops: WebSearchOperations = {
		searchEngine: options?.operations?.searchEngine ?? defaultSearchEngineOps(options),
		fallbackSearch: options?.operations?.fallbackSearch ?? ((query, numResults) => obscuraSearch(query, numResults)),
	};
	const rateLimiter = options?.rateLimiter ?? new EngineRateLimiter(MIN_ENGINE_GAP_MS);
	const maxResultsDefault = Math.min(
		Math.max(
			Math.round(resolveNumberEnv("AXIOM_WEBSEARCH_MAX_RESULTS", options?.maxResults ?? DEFAULT_MAX_RESULTS)),
			1,
		),
		MAX_RESULTS,
	);
	const cache = new Map<string, { block: string; details: WebSearchToolDetails }>();

	const definition: ToolDefinition<typeof webSearchSchema, WebSearchToolDetails | undefined> = {
		name: "web_search",
		label: "web_search",
		description: `Search the web natively, no API key. Scrapes DuckDuckGo html, then Bing, then falls back to the local Obscura browser. Returns one compact JSON array of {rank, title, url, snippet, date?}. Snippets cap at ${DEFAULT_SNIPPET_CAP} chars, results cap at ${MAX_RESULTS} (default ${maxResultsDefault}). All hops fail = error with reason.`,
		promptSnippet: "Keyless web search: DuckDuckGo, then Bing, then the local Obscura fallback",
		parameters: webSearchSchema,
		async execute(_toolCallId, rawInput, signal?, _onUpdate?, _ctx?) {
			const input = rawInput as WebSearchToolInput;
			const query = typeof input.query === "string" ? input.query.trim() : "";
			if (!query) {
				throw new Error("Web search query must be a non-empty string.");
			}
			const numResults = input.numResults ?? maxResultsDefault;
			if (!Number.isInteger(numResults) || numResults < 1 || numResults > MAX_RESULTS) {
				throw new Error(`numResults must be between 1 and ${MAX_RESULTS}.`);
			}
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const cacheKey = `${query.toLowerCase()}|${numResults}`;
			const hit = cache.get(cacheKey);
			if (hit) {
				return { content: [{ type: "text", text: hit.block }], details: { ...hit.details, cached: true } };
			}

			const engines: WebSearchEngineName[] = ["duckduckgo", "bing"];
			for (const engine of engines) {
				await rateLimiter.acquire(SEARCH_ENGINE_HOSTS[engine]);
				let raw: RawSearchResult[];
				try {
					raw = await ops.searchEngine(engine, query);
				} catch {
					raw = [];
				}
				if (raw.length > 0) {
					const results = normalizeSearchResults(raw, numResults);
					const block = buildSearchBlock(results);
					const details: WebSearchToolDetails = {
						query,
						engine,
						count: results.length,
						cached: false,
						truncated: raw.length > results.length,
					};
					cache.set(cacheKey, { block, details });
					return { content: [{ type: "text", text: block }], details };
				}
			}

			const fallback = await ops.fallbackSearch(query, numResults).catch(() => null);
			if (fallback && fallback.length > 0) {
				const results = normalizeSearchResults(fallback, numResults);
				const block = buildSearchBlock(results);
				const details: WebSearchToolDetails = {
					query,
					engine: "obscura",
					count: results.length,
					cached: false,
					truncated: fallback.length > results.length,
				};
				cache.set(cacheKey, { block, details });
				return { content: [{ type: "text", text: block }], details };
			}

			throw new Error("Web search failed: no results from any engine (duckduckgo, bing, obscura).");
		},
	};
	return definition;
}

export function createWebSearchTool(cwd: string, options?: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(cwd, options));
}
