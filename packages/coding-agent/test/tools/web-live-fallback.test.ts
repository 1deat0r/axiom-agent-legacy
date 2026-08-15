import { describe, expect, it } from "vitest";
import { obscuraFetchPage, obscuraSearch } from "../../src/core/tools/web-mcp-obscura.js";
import { createWebSearchTool } from "../../src/core/tools/web-search.js";

describe.skipIf(process.env.AXIOM_LIVE_WEB !== "1")("obscura fallback live", () => {
	it("obscuraSearch composes navigate + evaluate on the real server", async () => {
		const results = await obscuraSearch("rust async runtime", 3);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].url.startsWith("http")).toBe(true);
		expect(results[0].title.length).toBeGreaterThan(0);
	}, 60000);

	it("web_search falls back to the real obscura server when native engines yield nothing", async () => {
		const tool = createWebSearchTool(process.cwd(), {
			operations: { searchEngine: async () => [] },
		});
		const result = await tool.execute("live3", { query: "rust async runtime", numResults: 3 });
		expect(result.details.engine).toBe("obscura");
		const parsed = JSON.parse(
			result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"),
		) as Array<{ url: string }>;
		expect(parsed.length).toBeGreaterThan(0);
		expect(parsed[0].url.startsWith("http")).toBe(true);
	}, 60000);

	it("obscuraFetchPage reads a real page as markdown", async () => {
		const page = await obscuraFetchPage("https://example.com/", 2000);
		expect(page).not.toBeNull();
		expect(page!.markdown.length).toBeGreaterThan(0);
		expect(page!.markdown.length).toBeLessThanOrEqual(2000);
	}, 60000);
});
