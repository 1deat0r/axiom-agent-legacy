import { VERSION } from "../../config.js";
import type { RawSearchResult } from "./web-search.js";

/**
 * Minimal streamable-HTTP MCP client for the local Obscura server
 * (http://127.0.0.1:3000/mcp). Speaks just enough of the protocol for the
 * two fallback calls: tools/call websearch and tools/call fetch. Handles
 * both JSON and SSE response bodies. Errors throw; callers treat the
 * fallback as failed.
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

async function callTool(
	toolName: string,
	args: Record<string, unknown>,
	options: ObscuraClientOptions,
): Promise<unknown> {
	const endpoint = options.endpoint ?? process.env.OBSCURA_MCP_URL ?? "http://127.0.0.1:3000/mcp";
	const init = await mcpRequest(
		endpoint,
		"initialize",
		{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "axiom", version: VERSION } },
		options,
	);
	if (init.msg.error) {
		throw new Error(`Obscura MCP initialize failed: ${init.msg.error.message}`);
	}
	const call = await mcpRequest(
		endpoint,
		"tools/call",
		{ name: toolName, arguments: args },
		options,
		init.sessionId ?? undefined,
	);
	if (call.msg.error) {
		throw new Error(`Obscura MCP ${toolName} failed: ${call.msg.error.message}`);
	}
	return call.msg.result;
}

export async function obscuraSearch(
	query: string,
	numResults: number,
	options: ObscuraClientOptions = {},
): Promise<RawSearchResult[]> {
	const result = await callTool("websearch", { query, num_results: numResults }, options);
	const text = resultText(result);
	if (!text.trim()) {
		throw new Error("Obscura MCP websearch returned no text.");
	}
	const parsed = JSON.parse(text) as Array<{ title?: string; url?: string; snippet?: string }>;
	const out: RawSearchResult[] = [];
	for (const r of parsed) {
		if (r.title && r.url) {
			out.push({ title: r.title, url: r.url, snippet: r.snippet ?? "" });
		}
	}
	return out;
}

export async function obscuraFetchPage(
	url: string,
	maxChars: number,
	options: ObscuraClientOptions = {},
): Promise<{ title: string; markdown: string } | null> {
	const result = await callTool("fetch", { url, fmt: "markdown", max_chars: maxChars }, options);
	const text = resultText(result);
	if (!text.trim()) {
		return null;
	}
	return { title: "", markdown: text };
}
