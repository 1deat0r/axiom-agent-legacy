import { describe, expect, it } from "vitest";
import { transformMermaidBlocks } from "../src/core/mermaid-transform.js";

const theme = {
	border: (t: string) => `[B:${t}]`,
	edge: (t: string) => `[E:${t}]`,
	title: (t: string) => `[T:${t}]`,
};

describe("mermaid transform", () => {
	it("replaces a flowchart fence with box-drawing art", () => {
		const out = transformMermaidBlocks("before\n```mermaid\ngraph TD\nA[Start] --> B[Done]\n```\nafter", {
			enabled: true,
			maxWidth: 80,
			theme,
		});
		expect(out).toContain("before");
		expect(out).toContain("after");
		expect(out).not.toContain("```mermaid");
		expect(out).toContain("Start");
		expect(out).toContain("▼");
	});

	it("leaves the source untouched when disabled", () => {
		const src = "```mermaid\ngraph TD\nA --> B\n```";
		expect(transformMermaidBlocks(src, { enabled: false, maxWidth: 80, theme })).toBe(src);
	});

	it("keeps raw source for unsupported diagram types", () => {
		const src = "```mermaid\nsequenceDiagram\nA->>B: hi\n```";
		expect(transformMermaidBlocks(src, { enabled: true, maxWidth: 80, theme })).toBe(src);
	});

	it("keeps raw source when the art is wider than maxWidth", () => {
		const src = "```mermaid\ngraph LR\nA[aaaaaaaaaaaaaaaaaaaa] --> B[bbbbbbbbbbbbbbbbbbbb]\n```";
		expect(transformMermaidBlocks(src, { enabled: true, maxWidth: 12, theme })).toBe(src);
	});

	it("applies role themes to border, edge, and title lines", () => {
		const out = transformMermaidBlocks("```mermaid\ngraph TD\nsubgraph svc[Service]\n  A[API] --> B[DB]\nend\n```", {
			enabled: true,
			maxWidth: 80,
			theme,
		});
		expect(out).toContain("[B:"); // bordered line
		expect(out).toContain("[T:┌ Service┐]"); // title row themed as a unit
		expect(out).toContain("[E:"); // edge line
	});

	it("handles multiple fences", () => {
		const out = transformMermaidBlocks(
			"```mermaid\ngraph TD\nA --> B\n```\nmid\n```mermaid\ngraph TD\nC --> D\n```",
			{ enabled: true, maxWidth: 80, theme },
		);
		expect(out).toContain("mid");
		expect(out).toContain("▼");
		expect(out.match(/▼/g)?.length).toBe(2);
	});
});
