import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import {
	fetchPinned,
	type GateFn,
	type PinnedFetcher,
	UrlGateBlockError,
} from "../../extensions/security/fetch-pinned.js";
import type { UrlSafetyOptions } from "../../extensions/security/url.js";
import type { ToolDefinition } from "../extensions/types.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { htmlToMarkdown } from "./web-markdown.js";
import { obscuraFetchPage } from "./web-mcp-obscura.js";
import {
	axiomUserAgent,
	DEFAULT_FETCH_MAX_CHARS,
	DEFAULT_FETCH_TIMEOUT_MS,
	makeTimedPinnedFetcher,
	resolveNumberEnv,
} from "./web-shared.js";

export interface FetchedPage {
	title: string;
	markdown: string;
	truncated: boolean;
}

export type FetchPageFn = (url: string, maxChars: number) => Promise<FetchedPage>;
export type FallbackFetchFn = (url: string, maxChars: number) => Promise<{ title: string; markdown: string } | null>;

export interface WebFetchOperations {
	fetchPage: FetchPageFn;
	fallbackFetch: FallbackFetchFn;
}

export interface WebFetchToolOptions {
	operations?: Partial<WebFetchOperations>;
	timeoutMs?: number;
	maxChars?: number;
	gate?: GateFn;
	fetcher?: PinnedFetcher;
	gateOptions?: UrlSafetyOptions;
}

export const MIN_FETCH_MAX_CHARS = 100;
export const MAX_FETCH_MAX_CHARS = 100000;

function defaultFetchPageOps(options?: WebFetchToolOptions): FetchPageFn {
	const timeoutMs = options?.timeoutMs ?? resolveNumberEnv("AXIOM_WEBFETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS);
	const fetcher =
		options?.fetcher ?? makeTimedPinnedFetcher(timeoutMs, { "user-agent": axiomUserAgent(), accept: "text/html" });
	return async (url, maxChars) => {
		try {
			const res = await fetchPinned(url, { fetcher, gate: options?.gate, ...(options?.gateOptions ?? {}) });
			const html = await res.text();
			const { title, markdown } = htmlToMarkdown(html);
			const truncated = markdown.length > maxChars;
			const content = truncated ? markdown.slice(0, maxChars) : markdown;
			return { title, markdown: content, truncated };
		} catch (error) {
			if (error instanceof UrlGateBlockError) {
				throw new Error(`Web fetch blocked: ${error.message}`);
			}
			throw error;
		}
	};
}

const webFetchSchema = Type.Object({
	url: Type.String({ description: "URL to fetch (http or https)" }),
	maxChars: Type.Optional(
		Type.Number({ description: `Maximum characters of returned content (default ${DEFAULT_FETCH_MAX_CHARS})` }),
	),
});

export type WebFetchToolInput = Static<typeof webFetchSchema>;

export interface WebFetchToolDetails {
	url: string;
	source: "native" | "obscura";
	title: string;
	truncated: boolean;
	cached: boolean;
}

export function createWebFetchToolDefinition(
	_cwd: string,
	options?: WebFetchToolOptions,
): ToolDefinition<typeof webFetchSchema, WebFetchToolDetails | undefined> {
	const ops: WebFetchOperations = {
		fetchPage: options?.operations?.fetchPage ?? defaultFetchPageOps(options),
		fallbackFetch: options?.operations?.fallbackFetch ?? ((url, maxChars) => obscuraFetchPage(url, maxChars)),
	};
	const maxCharsDefault = Math.min(
		Math.max(
			Math.round(resolveNumberEnv("AXIOM_WEBFETCH_MAX_CHARS", options?.maxChars ?? DEFAULT_FETCH_MAX_CHARS)),
			MIN_FETCH_MAX_CHARS,
		),
		MAX_FETCH_MAX_CHARS,
	);
	const cache = new Map<string, { block: string; details: WebFetchToolDetails }>();

	const definition: ToolDefinition<typeof webFetchSchema, WebFetchToolDetails | undefined> = {
		name: "web_fetch",
		label: "web_fetch",
		description: `Fetch a web page and return it as markdown. Every URL passes the URL safety gate (ADR-0057, ADR-0066): private, loopback, and link-local targets are blocked. Content hard-caps at maxChars (default ${DEFAULT_FETCH_MAX_CHARS}). Falls back to the local Obscura browser when the page yields no parseable content.`,
		promptSnippet: "Fetch a page as markdown, gated against SSRF and DNS rebinding",
		parameters: webFetchSchema,
		async execute(_toolCallId, rawInput, signal?, _onUpdate?, _ctx?) {
			const input = rawInput as WebFetchToolInput;
			const url = typeof input.url === "string" ? input.url.trim() : "";
			if (!url) {
				throw new Error("Web fetch url must be a non-empty string.");
			}
			const maxChars = input.maxChars ?? maxCharsDefault;
			if (!Number.isInteger(maxChars) || maxChars < MIN_FETCH_MAX_CHARS || maxChars > MAX_FETCH_MAX_CHARS) {
				throw new Error(`maxChars must be between ${MIN_FETCH_MAX_CHARS} and ${MAX_FETCH_MAX_CHARS}.`);
			}
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const cacheKey = `${url}|${maxChars}`;
			const hit = cache.get(cacheKey);
			if (hit) {
				return { content: [{ type: "text", text: hit.block }], details: { ...hit.details, cached: true } };
			}

			const native = await ops.fetchPage(url, maxChars);
			let title = native.title;
			let content = native.markdown;
			let truncated = native.truncated;
			let source: "native" | "obscura" = "native";
			if (content.trim() === "") {
				const fallback = await ops.fallbackFetch(url, maxChars).catch(() => null);
				if (fallback && fallback.markdown.trim() !== "") {
					source = "obscura";
					title = fallback.title || title;
					content = fallback.markdown;
					truncated = false;
				} else {
					throw new Error(`Web fetch failed: no parseable content for ${url}.`);
				}
			}

			const block = JSON.stringify({ url, title, content });
			const details: WebFetchToolDetails = { url, source, title, truncated, cached: false };
			cache.set(cacheKey, { block, details });
			return { content: [{ type: "text", text: block }], details };
		},
	};
	return definition;
}

export function createWebFetchTool(cwd: string, options?: WebFetchToolOptions): AgentTool<typeof webFetchSchema> {
	return wrapToolDefinition(createWebFetchToolDefinition(cwd, options));
}
