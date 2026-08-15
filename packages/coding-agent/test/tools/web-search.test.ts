import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildSearchBlock,
	createWebSearchTool,
	normalizeSearchResults,
	parseBingHtml,
	parseDdgHtml,
	type RawSearchResult,
	type WebSearchOperations,
} from "../../src/core/tools/web-search.js";
import { EngineRateLimiter } from "../../src/core/tools/web-shared.js";

function getText(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") ?? ""
	);
}

const DDG_RESULTS_HTML = `
<html><body>
<div class="result results_links results_links_deep web-result">
<h2 class="result__title"><a rel="nofollow" class="result__a" href="https://tokio.rs/">Tokio - An asynchronous Rust runtime</a></h2>
<div class="result__snippet">Tokio is an event-driven, non-blocking I/O platform for writing asynchronous applications with Rust.</div>
</div>
<div class="result results_links results_links_deep web-result">
<h2 class="result__title"><a rel="nofollow" class="result__a" href="https://rust-lang.github.io/async-book/">Asynchronous Programming in Rust</a></h2>
<a class="result__snippet" href="https://rust-lang.github.io/async-book/">The async book explains futures, executors, and how async runtimes work.</a>
</div>
<div data-result>
<a class="result__a" href="https://docs.rs/tokio">tokio - Rust</a>
<span class="result__snippet">Documentation for the tokio crate.</span>
</div>
</body></html>`;

const FIXTURES = join(process.cwd(), "test", "tools", "fixtures");

function makeOps(overrides: Partial<WebSearchOperations>): WebSearchOperations {
	return {
		searchEngine: vi.fn(async (_engine, _query) => []),
		fallbackSearch: vi.fn(async () => null),
		...overrides,
	};
}

function one(query: string): RawSearchResult[] {
	return [
		{ title: `Title for ${query}`, url: `https://example.com/${encodeURIComponent(query)}`, snippet: "A snippet." },
	];
}

describe("web search parsers", () => {
	it("parseDdgHtml extracts title, url, and snippet from result blocks", () => {
		const results = parseDdgHtml(DDG_RESULTS_HTML);
		expect(results).toHaveLength(3);
		expect(results[0].url).toBe("https://tokio.rs/");
		expect(results[0].title).toContain("Tokio");
		expect(results[0].snippet.length).toBeGreaterThan(0);
	});

	it("parseDdgHtml unwraps duckduckgo redirect urls", () => {
		const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftokio.rs%2F&rut=abc123">Tokio</a>`;
		const results = parseDdgHtml(html);
		expect(results[0].url).toBe("https://tokio.rs/");
	});

	it("parseDdgHtml returns no results for the anomaly challenge page", () => {
		const html = readFileSync(join(FIXTURES, "ddg-rust-async.html"), "utf8");
		expect(parseDdgHtml(html)).toEqual([]);
	});

	it("parseBingHtml extracts results from real Bing markup", () => {
		const html = readFileSync(join(FIXTURES, "bing-rust-async.html"), "utf8");
		const results = parseBingHtml(html);
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.url.startsWith("http")).toBe(true);
			expect(r.title.length).toBeGreaterThan(0);
		}
		expect(results[0].snippet.length).toBeGreaterThan(0);
	});

	it("normalizeSearchResults dedupes by url, caps snippets, and slices to maxResults", () => {
		const long = "x".repeat(500);
		const input: RawSearchResult[] = [
			{ title: "A", url: "https://a.example/", snippet: long },
			{ title: "A2", url: "https://a.example/", snippet: "dupe" },
			{ title: "B", url: "https://b.example/", snippet: "b" },
			{ title: "C", url: "https://c.example/", snippet: "c" },
		];
		const results = normalizeSearchResults(input, 2);
		expect(results).toHaveLength(2);
		expect(results[0].url).toBe("https://a.example/");
		expect(results[0].snippet.length).toBeLessThanOrEqual(200);
		expect(results[0].rank).toBe(1);
		expect(results[1].rank).toBe(2);
	});

	it("buildSearchBlock caps the total block size and stays parseable", () => {
		const results = normalizeSearchResults(
			Array.from({ length: 10 }, (_, i) => ({
				title: `T${i}`,
				url: `https://e.example/${i}`,
				snippet: "s".repeat(300),
			})),
			10,
		);
		const block = buildSearchBlock(results, 500);
		expect(block.length).toBeLessThanOrEqual(502);
		const parsed = JSON.parse(block) as unknown[];
		expect(parsed.length).toBeGreaterThan(0);
	});
});

describe("web search tool", () => {
	it("uses bing when duckduckgo yields nothing", async () => {
		const ops = makeOps({
			searchEngine: vi.fn(async (engine) => (engine === "duckduckgo" ? [] : one("rust"))),
		});
		const tool = createWebSearchTool(process.cwd(), { operations: ops });
		const result = await tool.execute("c1", { query: "rust async runtime" });
		expect(result.details.engine).toBe("bing");
		expect(result.details.cached).toBe(false);
		expect(ops.fallbackSearch).not.toHaveBeenCalled();
		const parsed = JSON.parse(getText(result)) as unknown[];
		expect(parsed).toHaveLength(1);
	});

	it("falls back to obscura when both engines yield nothing", async () => {
		const ops = makeOps({
			searchEngine: vi.fn(async () => []),
			fallbackSearch: vi.fn(async () => one("fallback")),
		});
		const tool = createWebSearchTool(process.cwd(), { operations: ops });
		const result = await tool.execute("c1", { query: "anything" });
		expect(result.details.engine).toBe("obscura");
		expect(ops.fallbackSearch).toHaveBeenCalledOnce();
	});

	it("throws when all hops yield nothing", async () => {
		const tool = createWebSearchTool(process.cwd(), { operations: makeOps({}) });
		await expect(tool.execute("c1", { query: "nothing" })).rejects.toThrow(/no results from any engine/);
	});

	it("caches identical queries in-run", async () => {
		const searchEngine = vi.fn(async (engine) => (engine === "duckduckgo" ? one("cached") : []));
		const ops = makeOps({ searchEngine });
		const tool = createWebSearchTool(process.cwd(), { operations: ops });
		await tool.execute("c1", { query: "same query" });
		const second = await tool.execute("c2", { query: "same query" });
		expect(second.details.cached).toBe(true);
		expect(searchEngine).toHaveBeenCalledOnce();
	});

	it("spaces requests to the same engine host by the minimum gap", async () => {
		let t = 0;
		const slept: number[] = [];
		const limiter = new EngineRateLimiter(
			1000,
			() => t,
			async (ms) => {
				slept.push(ms);
				t += ms;
			},
		);
		const ops = makeOps({
			searchEngine: vi.fn(async () => one("x")),
		});
		const tool = createWebSearchTool(process.cwd(), { operations: ops, rateLimiter: limiter });
		await tool.execute("c1", { query: "first" });
		t += 200;
		await tool.execute("c2", { query: "second" });
		expect(slept.length).toBeGreaterThan(0);
		expect(slept[0]).toBe(800);
	});

	it("validates input", async () => {
		const tool = createWebSearchTool(process.cwd(), { operations: makeOps({}) });
		await expect(tool.execute("c1", { query: "   " })).rejects.toThrow(/non-empty/);
		await expect(tool.execute("c1", { query: "x", numResults: 0 })).rejects.toThrow(/between 1 and 10/);
		await expect(tool.execute("c1", { query: "x", numResults: 11 })).rejects.toThrow(/between 1 and 10/);
	});

	it("returns a parseable JSON array with rank", async () => {
		const ops = makeOps({ searchEngine: vi.fn(async () => one("rank")) });
		const tool = createWebSearchTool(process.cwd(), { operations: ops });
		const result = await tool.execute("c1", { query: "ranked", numResults: 3 });
		const parsed = JSON.parse(getText(result)) as Array<{ rank: number }>;
		expect(parsed[0].rank).toBe(1);
	});
});
