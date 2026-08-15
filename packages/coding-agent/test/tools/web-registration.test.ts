import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { createWebFetchTool, createWebSearchTool } from "../../src/core/sdk.js";
import { createAllToolDefinitions, createTool } from "../../src/core/tools/index.js";

describe("web tool registration", () => {
	it("registers both tools in createAllToolDefinitions", () => {
		const defs = createAllToolDefinitions(process.cwd());
		expect(defs.web_search.name).toBe("web_search");
		expect(defs.web_fetch.name).toBe("web_fetch");
	});

	it("creates both tools by name", () => {
		expect(createTool("web_search", process.cwd()).name).toBe("web_search");
		expect(createTool("web_fetch", process.cwd()).name).toBe("web_fetch");
	});

	it("lists both tools in the CLI builtin tool diagnostics", () => {
		const result = parseArgs(["--tools", "grep"]);
		const message = result.diagnostics.find((d) => d.type === "error")?.message ?? "";
		expect(message).toContain("web_search");
		expect(message).toContain("web_fetch");
	});

	it("re-exports both factories from the sdk", () => {
		expect(typeof createWebSearchTool).toBe("function");
		expect(typeof createWebFetchTool).toBe("function");
	});
});
