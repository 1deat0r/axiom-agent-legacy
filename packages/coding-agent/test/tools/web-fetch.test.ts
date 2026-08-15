import { describe, expect, it, vi } from "vitest";
import { createWebFetchTool, type WebFetchOperations } from "../../src/core/tools/web-fetch.js";
import { htmlToMarkdown } from "../../src/core/tools/web-markdown.js";

function getText(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") ?? ""
	);
}

function makeOps(overrides: Partial<WebFetchOperations>): WebFetchOperations {
	return {
		fetchPage: vi.fn(async () => ({ title: "", markdown: "", truncated: false })),
		fallbackFetch: vi.fn(async () => null),
		...overrides,
	};
}

describe("htmlToMarkdown", () => {
	it("extracts title and converts headings, links, and lists", () => {
		const html = `<html><head><title>Doc Title</title></head><body>
<h1>Heading One</h1>
<p>A <a href="https://example.com/x">link</a> here.</p>
<ul><li>item one</li><li>item two</li></ul>
</body></html>`;
		const { title, markdown } = htmlToMarkdown(html);
		expect(title).toBe("Doc Title");
		expect(markdown).toContain("# Heading One");
		expect(markdown).toContain("[link](https://example.com/x)");
		expect(markdown).toContain("- item one");
		expect(markdown).toContain("- item two");
	});

	it("strips script and style content", () => {
		const html = `<html><body><script>alert("boom")</script><style>.x{}</style><p>safe</p></body></html>`;
		const { markdown } = htmlToMarkdown(html);
		expect(markdown).not.toContain("boom");
		expect(markdown).not.toContain(".x{}");
		expect(markdown).toContain("safe");
	});

	it("decodes entities", () => {
		const { markdown } = htmlToMarkdown(`<html><body><p>a &amp; b &lt; c &gt; d &#39;e&#39;</p></body></html>`);
		expect(markdown).toContain("a & b < c > d 'e'");
	});
});

describe("web fetch tool", () => {
	it("returns markdown for a public url", async () => {
		const ops = makeOps({
			fetchPage: vi.fn(async () => ({ title: "T", markdown: "Hello world", truncated: false })),
		});
		const tool = createWebFetchTool(process.cwd(), { operations: ops });
		const result = await tool.execute("c1", { url: "https://example.com/" });
		expect(result.details.source).toBe("native");
		const parsed = JSON.parse(getText(result));
		expect(parsed).toEqual({ url: "https://example.com/", title: "T", content: "Hello world" });
	});

	it("falls back to obscura when the page yields no content", async () => {
		const ops = makeOps({
			fetchPage: vi.fn(async () => ({ title: "", markdown: "", truncated: false })),
			fallbackFetch: vi.fn(async () => ({ title: "", markdown: "fallback text" })),
		});
		const tool = createWebFetchTool(process.cwd(), { operations: ops });
		const result = await tool.execute("c1", { url: "https://example.com/js-only" });
		expect(result.details.source).toBe("obscura");
		expect(ops.fallbackFetch).toHaveBeenCalledOnce();
		expect(JSON.parse(getText(result)).content).toBe("fallback text");
	});

	it("throws when native and fallback both yield nothing", async () => {
		const tool = createWebFetchTool(process.cwd(), { operations: makeOps({}) });
		await expect(tool.execute("c1", { url: "https://example.com/empty" })).rejects.toThrow(/no parseable content/);
	});

	it("caches identical url and cap", async () => {
		const fetchPage = vi.fn(async () => ({ title: "T", markdown: "body", truncated: false }));
		const ops = makeOps({ fetchPage });
		const tool = createWebFetchTool(process.cwd(), { operations: ops });
		await tool.execute("c1", { url: "https://example.com/cached" });
		const second = await tool.execute("c2", { url: "https://example.com/cached" });
		expect(second.details.cached).toBe(true);
		expect(fetchPage).toHaveBeenCalledOnce();
	});

	it("validates input", async () => {
		const tool = createWebFetchTool(process.cwd(), { operations: makeOps({}) });
		await expect(tool.execute("c1", { url: "" })).rejects.toThrow(/non-empty/);
		await expect(tool.execute("c1", { url: "https://example.com/", maxChars: 0 })).rejects.toThrow(/between/);
	});
});
