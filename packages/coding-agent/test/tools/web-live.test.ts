/**
 * Live-gated suite for the native web tools (ADR-0074). Skipped unless
 * AXIOM_LIVE_WEB=1. Exercises the real default operations: Bing scraping,
 * the DuckDuckGo anomaly path, and the Obscura MCP fallback. Never runs in
 * the neutral test.sh floor.
 */
import { describe, expect, it } from "vitest";
import { createWebFetchTool } from "../../src/core/tools/web-fetch.js";
import { createWebSearchTool } from "../../src/core/tools/web-search.js";

const LIVE = process.env.AXIOM_LIVE_WEB === "1";

describe.skipIf(!LIVE)("web tools live", () => {
	it("web_search returns parseable results for a real query", async () => {
		const tool = createWebSearchTool(process.cwd(), { maxResults: 5 });
		const result = await tool.execute("live1", { query: "rust async runtime" });
		const parsed = JSON.parse(
			result.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n"),
		) as Array<{ rank: number; title: string; url: string; snippet: string }>;
		expect(parsed.length).toBeGreaterThan(0);
		expect(parsed[0].url.startsWith("http")).toBe(true);
		expect(["duckduckgo", "bing", "obscura"]).toContain(result.details.engine);
	});

	it("web_fetch reads a public page as markdown", async () => {
		const tool = createWebFetchTool(process.cwd(), { maxChars: 2000 });
		const result = await tool.execute("live2", { url: "https://example.com/" });
		const parsed = JSON.parse(
			result.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n"),
		) as { url: string; content: string };
		expect(parsed.content.length).toBeGreaterThan(0);
		expect(result.details.source === "native" || result.details.source === "obscura").toBe(true);
	});
});
