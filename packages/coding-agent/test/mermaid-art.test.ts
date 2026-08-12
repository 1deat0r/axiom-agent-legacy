import { describe, expect, it } from "vitest";
import { parseMermaidGraph, renderMermaid } from "../src/core/mermaid-art/index.js";

describe("mermaid-art parser", () => {
	it("returns null for blank input", () => {
		expect(parseMermaidGraph("")).toBeNull();
		expect(parseMermaidGraph("   ")).toBeNull();
	});

	it("returns null for unsupported diagram types", () => {
		for (const header of [
			"sequenceDiagram\nA->>B: hi",
			'pie title P\n  "A" : 1',
			"gantt\ntitle G",
			"stateDiagram-v2\nA --> B",
			"classDiagram\nA --|> B",
			"erDiagram\nA ||--o{ B",
			"journey\ntitle J",
			"mindmap\nroot((x))",
		]) {
			expect(parseMermaidGraph(header)).toBeNull();
		}
	});

	it("parses header direction and defaults to TD", () => {
		expect(parseMermaidGraph("graph LR\nA --> B")?.direction).toBe("LR");
		expect(parseMermaidGraph("flowchart TD\nA --> B")?.direction).toBe("TD");
		expect(parseMermaidGraph("graph\nA --> B")?.direction).toBe("TD");
		expect(parseMermaidGraph("A --> B")?.direction).toBe("TD");
	});

	it("parses node shapes", () => {
		const graph = parseMermaidGraph(
			"graph TD\nA[rect] --> B(rounded) --> C((circle)) --> D{diamond} --> E([stadium])",
		);
		expect(graph).not.toBeNull();
		expect(graph?.nodes.get("A")?.shape).toBe("rect");
		expect(graph!.nodes.get("B")?.shape).toBe("rounded");
		expect(graph!.nodes.get("C")?.shape).toBe("circle");
		expect(graph!.nodes.get("D")?.shape).toBe("diamond");
		expect(graph!.nodes.get("E")?.shape).toBe("stadium");
		expect(graph!.edges).toHaveLength(4);
	});

	it("parses edge styles and labels in every form", () => {
		const graph = parseMermaidGraph(
			[
				"graph TD",
				"A --> B",
				"B --- C",
				"C -.-> D",
				"D ==> E",
				"E -- plain label --> F",
				"F -. dotted label .-> G",
				"G == thick label ==> H",
				"H -->|pipe| I",
				"I ---|pipe2| J",
			].join("\n"),
		);
		expect(graph).not.toBeNull();
		const edges = graph!.edges;
		expect(edges[0]).toMatchObject({ from: "A", to: "B", style: "solid", directed: true });
		expect(edges[1]).toMatchObject({ from: "B", to: "C", directed: false });
		expect(edges[2]).toMatchObject({ from: "C", to: "D", style: "dotted" });
		expect(edges[3]).toMatchObject({ from: "D", to: "E", style: "thick" });
		expect(edges[4]!.label).toBe("plain label");
		expect(edges[5]!.label).toBe("dotted label");
		expect(edges[6]!.label).toBe("thick label");
		expect(edges[7]!.label).toBe("pipe");
		expect(edges[8]!.label).toBe("pipe2");
	});

	it("supports chained statements and multiline node text", () => {
		const graph = parseMermaidGraph("graph TD\nA --> B --> C\nD[line1<br/>line2] --> A");
		expect(graph?.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["A->B", "B->C", "D->A"]);
		expect(graph?.nodes.get("D")?.text).toEqual(["line1", "line2"]);
	});

	it("records subgraph membership", () => {
		const graph = parseMermaidGraph("graph TD\nsubgraph svc[Service]\n  A[API] --> B[DB]\nend\nC[Client] --> A");
		expect(graph?.subgraphs).toHaveLength(1);
		expect(graph?.subgraphs[0]).toMatchObject({ id: "svc", title: "Service" });
		expect(graph?.subgraphs[0]?.nodes).toEqual(["A", "B"]);
		expect(graph?.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["A->B", "C->A"]);
	});

	it("is lenient: keeps the parseable prefix and reports warnings", () => {
		const graph = parseMermaidGraph("graph TD\nA --> B\ngarbage line here\nB --> C");
		expect(graph).not.toBeNull();
		expect(graph!.nodes.has("A")).toBe(true);
		expect(graph!.nodes.has("C")).toBe(true);
		expect(graph!.warnings.length).toBeGreaterThan(0);
	});

	it("ignores comments, classDef, and style lines", () => {
		const graph = parseMermaidGraph("graph TD\n%% a comment\nclassDef blue fill:#08f\nstyle A fill:#fff\nA --> B");
		expect(graph?.edges).toHaveLength(1);
		expect(graph?.warnings).toHaveLength(0);
	});
});

describe("mermaid-art renderer", () => {
	it("draws a TD chain with boxes and down arrows", () => {
		const art = renderMermaid("graph TD\nA[Start] --> B[Done]");
		expect(art).not.toBeNull();
		const text = art!.lines.join("\n");
		expect(text).toContain("┌");
		expect(text).toContain("└");
		expect(text).toContain("Start");
		expect(text).toContain("Done");
		expect(text).toContain("▼");
	});

	it("draws LR with right arrows", () => {
		const art = renderMermaid("graph LR\nA[Start] --> B[Done]");
		expect(art).not.toBeNull();
		expect(art!.lines.join("\n")).toContain("▶");
	});

	it("draws a diamond decision node", () => {
		const art = renderMermaid("graph TD\nA[Go] --> B{Ready?}\nB -->|yes| C[Go on]");
		const text = art!.lines.join("\n");
		expect(text).toContain("┬");
		expect(text).toContain("Ready?");
	});

	it("renders edge labels", () => {
		const art = renderMermaid("graph TD\nA -->|yes| B");
		expect(art!.lines.join("\n")).toContain("yes");
	});

	it("renders dotted and thick edges", () => {
		const dotted = renderMermaid("graph TD\nA -.-> B");
		const thick = renderMermaid("graph TD\nA ==> B");
		const dottedLR = renderMermaid("graph LR\nA -.-> B");
		const thickLR = renderMermaid("graph LR\nA ==> B");
		expect(dotted!.lines.join("\n")).toContain("╎"); // vertical dotted
		expect(thick!.lines.join("\n")).toContain("║"); // vertical thick
		expect(dottedLR!.lines.join("\n")).toContain("╌"); // horizontal dotted
		expect(thickLR!.lines.join("\n")).toContain("═"); // horizontal thick
	});

	it("draws a subgraph frame with its title", () => {
		const art = renderMermaid("graph TD\nsubgraph svc[Service]\n  A[API] --> B[DB]\nend\nC[Client] --> A");
		expect(art).not.toBeNull();
		const text = art!.lines.join("\n");
		expect(text).toContain("Service");
		expect(text).toContain("┌");
		expect(text).toContain("└");
	});

	it("returns null when wider than maxWidth", () => {
		const art = renderMermaid("graph LR\nA[aaaaaaaaaaaaaaaaaaaa] --> B[bbbbbbbbbbbbbbbbbbbb]", {
			maxWidth: 12,
		});
		expect(art).toBeNull();
	});

	it("assigns per-line roles for theming", () => {
		const art = renderMermaid("graph TD\nA[Start] --> B[Done]");
		expect(art!.roles).toHaveLength(art!.lines.length);
		expect(art!.roles).toContain("border");
		expect(art!.roles).toContain("node");
		expect(art!.roles).toContain("edge");
	});

	it("routes back edges around the diagram without crossing boxes", () => {
		const art = renderMermaid("graph TD\nA --> B\nB --> C\nC --> A");
		expect(art).not.toBeNull();
		const text = art!.lines.join("\n");
		// The arrowhead lands on B's right edge; the lane runs outside.
		expect(text).toContain("│ B │◀└");
		expect(text).toContain("┌───└");
		// No horizontal run may pass through a box interior.
		expect(text).not.toContain("─B─");
	});

	it("keeps labels on both directions of a back edge", () => {
		const art = renderMermaid("graph TD\nA[Ask] -->|question| B[Answer]\nB -->|response| A");
		expect(art).not.toBeNull();
		const text = art!.lines.join("\n");
		expect(text).toContain("question");
		expect(text).toContain("response");
	});

	it("labels never overwrite box borders (LR pipeline)", () => {
		const art = renderMermaid(
			"graph LR\nA[Commit] --> B{CI Pass?}\nB -->|yes| C[Deploy]\nB -->|no| D[Fix]\nD --> A\nC --> E[Notify]",
		);
		expect(art).not.toBeNull();
		const text = art!.lines.join("\n");
		// "yes" must not sit on the diamond's top border row.
		const topRow = art!.lines.find((l) => l.includes("╭"));
		expect(topRow).toBeDefined();
		expect(topRow).not.toContain("yes");
		expect(text).toContain("yes");
		expect(text).toContain("no");
		// Back edge enters the diamond from the left, arrowhead on the border.
		expect(text).toContain("└─▶│ CI Pass?");
		// The C->E corner over D->A's line becomes a junction.
		expect(text).toContain("┬");
	});

	it("same-rank branch keeps both routes readable via a junction", () => {
		const art = renderMermaid("graph TD\nA[One] --> B[Two]\nA --- C[Three]");
		expect(art).not.toBeNull();
		expect(art!.lines.join("\n")).toContain("├");
	});

	it("routes rank-skipping edges outside without crossing intermediate boxes", () => {
		const art = renderMermaid("graph TD\nA --> B\nB --> C\nA --> C");
		expect(art).not.toBeNull();
		const text = art!.lines.join("\n");
		expect(text).toContain("│ B │");
		expect(text).not.toContain("─B─");
		expect(text.match(/▼/g)?.length).toBeGreaterThanOrEqual(2);
	});

	it("flattens nested subgraphs without stray end warnings", () => {
		const graph = parseMermaidGraph(
			"graph TD\nsubgraph outer[Outer]\n  A --> B\n  subgraph inner[Inner]\n    C --> D\n  end\nend",
		);
		expect(graph?.subgraphs).toHaveLength(1);
		expect(graph?.subgraphs[0]).toMatchObject({ id: "outer", title: "Outer" });
		expect(graph?.subgraphs[0]?.nodes).toEqual(["A", "B", "C", "D"]);
		expect(graph?.warnings).toContain("nested subgraphs are not drawn; flattening");
		expect(graph?.warnings).not.toContain("unexpected 'end'");
	});

	it("re-checks width after frames and outside lanes grow the grid", () => {
		const art = renderMermaid("graph TD\nsubgraph s[Very Long Service Name]\n  A[API]\nend\nB --> A", {
			maxWidth: 12,
		});
		expect(art).toBeNull();
	});

	it("LR advancing edge arrowheads sit on the target's left border", () => {
		const art = renderMermaid("graph LR\nA --> B\nA --> C");
		expect(art).not.toBeNull();
		const text = art!.lines.join("\n");
		// The arrowhead touches the lower target box's left border.
		expect(text).toMatch(/▶│ C │/);
		expect(text).toMatch(/─▶│ B │/);
	});

	it("returns null for unsupported input via one-shot", () => {
		expect(renderMermaid("sequenceDiagram\nA->>B: hi")).toBeNull();
	});
});
