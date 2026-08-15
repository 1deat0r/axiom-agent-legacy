import { VERSION } from "../../config.js";
import type { RawSearchResult } from "./web-search.js";
import { SEARCH_ENGINE_URLS, unwrapDdgUrl } from "./web-shared.js";

/**
 * Minimal streamable-HTTP MCP client for the local Obscura server
 * (http://127.0.0.1:3000/mcp). Speaks just enough of the protocol for the
 * fallback hops: browser_navigate + browser_evaluate for search, and
 * browser_navigate + browser_markdown for fetch. Handles JSON and SSE
 * response bodies and MCP isError results. All calls share one session so
 * the navigate/evaluate pairs land in the same browser. Errors throw;
 * callers treat the fallback as failed.
 */

export interface ObscuraClientOptions {
	endpoint?: string;
	timeoutMs?: number;
	fetchFn?: typeof fetch;
}

const DEFAULT_OBSCURA_TIMEOUT_MS = 15000;

interface McpMessage {
	result?: unknown;
	error?: { code: number; message: string };
}

let nextRequestId = 1;

function parseSse(text: string): McpMessage {
	let last: McpMessage | null = null;
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("data:")) {
			continue;
		}
		const payload = line.slice(5).trim();
		if (!payload) {
			continue;
		}
		try {
			const obj = JSON.parse(payload) as McpMessage;
			if (obj.result !== undefined || obj.error !== undefined) {
				last = obj;
			}
		} catch {
			// Non-JSON keep-alive lines are not messages.
		}
	}
	if (!last) {
		throw new Error("Obscura MCP: no JSON-RPC message in stream.");
	}
	return last;
}

async function mcpRequest(
	endpoint: string,
	method: string,
	params: unknown,
	options: ObscuraClientOptions,
	sessionId?: string,
): Promise<{ msg: McpMessage; sessionId: string | null }> {
	const fetchFn = options.fetchFn ?? fetch;
	const res = await fetchFn(endpoint, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(sessionId ? { "mcp-session-id": sessionId } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: nextRequestId++, method, params }),
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_OBSCURA_TIMEOUT_MS),
	});
	const sid = res.headers.get("mcp-session-id");
	const contentType = res.headers.get("content-type") ?? "";
	const text = await res.text();
	const msg = contentType.includes("text/event-stream") ? parseSse(text) : (JSON.parse(text) as McpMessage);
	return { msg, sessionId: sid };
}

function resultText(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

async function openSession(endpoint: string, options: ObscuraClientOptions): Promise<string | undefined> {
	const init = await mcpRequest(
		endpoint,
		"initialize",
		{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "axiom", version: VERSION } },
		options,
	);
	if (init.msg.error) {
		throw new Error(`Obscura MCP initialize failed: ${init.msg.error.message}`);
	}
	return init.sessionId ?? undefined;
}

async function callToolInSession(
	endpoint: string,
	toolName: string,
	args: Record<string, unknown>,
	options: ObscuraClientOptions,
	sessionId: string | undefined,
): Promise<unknown> {
	const call = await mcpRequest(endpoint, "tools/call", { name: toolName, arguments: args }, options, sessionId);
	if (call.msg.error) {
		throw new Error(`Obscura MCP ${toolName} failed: ${call.msg.error.message}`);
	}
	const result = call.msg.result as { isError?: boolean } | undefined;
	if (result && result.isError === true) {
		throw new Error(`Obscura MCP ${toolName} failed: ${resultText(result)}`);
	}
	return result;
}

function resolveEndpoint(options: ObscuraClientOptions): string {
	return options.endpoint ?? process.env.OBSCURA_MCP_URL ?? "http://127.0.0.1:3000/mcp";
}

/** Per-engine extraction expressions, mirroring the Obscura python client. */
const EXTRACT_JS: Record<string, string> = {
	duckduckgo:
		"(() => { const out = []; for (const r of document.querySelectorAll('.result, [data-result]')) { const a = r.querySelector('a.result__a') || r.querySelector('h2 a'); if (!a) continue; const sn = r.querySelector('.result__snippet'); out.push({ title: a.innerText.trim(), url: a.href, snippet: sn ? sn.innerText.trim() : '' }); } return out; })()",
	bing: "(() => { const out = []; for (const li of document.querySelectorAll('li.b_algo')) { const a = li.querySelector('h2 a'); if (!a) continue; const sn = li.querySelector('.b_caption p, p'); out.push({ title: a.innerText.trim(), url: a.href, snippet: sn ? sn.innerText.trim() : '' }); } return out; })()",
	google:
		"(() => { const out = []; for (const g of document.querySelectorAll('div.g, div[data-hveid]')) { const a = g.querySelector('a[href^=\"http\"]'); const h3 = g.querySelector('h3'); if (!a || !h3) continue; const sn = g.querySelector('.VwiC3b, [data-sncf], [style*=\"-webkit-line-clamp\"]'); out.push({ title: h3.innerText.trim(), url: a.href, snippet: sn ? sn.innerText.trim() : '' }); } return out; })()",
};

const FALLBACK_ENGINES = ["duckduckgo", "bing", "google"] as const;

const FALLBACK_URLS: Record<(typeof FALLBACK_ENGINES)[number], (query: string) => string> = {
	duckduckgo: SEARCH_ENGINE_URLS.duckduckgo,
	bing: SEARCH_ENGINE_URLS.bing,
	google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
};

interface ExtractedItem {
	title?: string;
	url?: string;
	snippet?: string;
}

function coerceItems(raw: unknown): ExtractedItem[] {
	const text = resultText(raw).trim();
	if (!text.startsWith("[")) {
		return [];
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter((x): x is ExtractedItem => typeof x === "object" && x !== null);
	} catch {
		return [];
	}
}

export async function obscuraSearch(
	query: string,
	numResults: number,
	options: ObscuraClientOptions = {},
): Promise<RawSearchResult[]> {
	const endpoint = resolveEndpoint(options);
	const sessionId = await openSession(endpoint, options);
	for (const engine of FALLBACK_ENGINES) {
		try {
			await callToolInSession(
				endpoint,
				"browser_navigate",
				{ url: FALLBACK_URLS[engine](query) },
				options,
				sessionId,
			);
			const raw = await callToolInSession(
				endpoint,
				"browser_evaluate",
				{ expression: EXTRACT_JS[engine] },
				options,
				sessionId,
			);
			const out: RawSearchResult[] = [];
			for (const item of coerceItems(raw)) {
				const url = unwrapDdgUrl(String(item.url ?? "").trim());
				if (!url.startsWith("http") || !item.title) {
					continue;
				}
				out.push({ title: String(item.title).trim(), url, snippet: String(item.snippet ?? "").trim() });
				if (out.length >= numResults) {
					break;
				}
			}
			if (out.length > 0) {
				return out;
			}
		} catch {
			// Next engine. The last engine's failure is reported below.
		}
	}
	throw new Error("Obscura MCP websearch found no results for the query.");
}

export async function obscuraFetchPage(
	url: string,
	maxChars: number,
	options: ObscuraClientOptions = {},
): Promise<{ title: string; markdown: string } | null> {
	const endpoint = resolveEndpoint(options);
	const sessionId = await openSession(endpoint, options);
	await callToolInSession(endpoint, "browser_navigate", { url }, options, sessionId);
	const raw = await callToolInSession(endpoint, "browser_markdown", {}, options, sessionId);
	const text = resultText(raw).trim();
	if (!text) {
		return null;
	}
	return { title: "", markdown: text.length > maxChars ? text.slice(0, maxChars) : text };
}
