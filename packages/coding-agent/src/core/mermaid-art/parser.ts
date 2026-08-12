/**
 * Lenient parser for the Mermaid subset the in-repo terminal renderer draws:
 * `graph`/`flowchart` diagrams with node shapes, labelled edges (solid,
 * dotted, thick), and single-level subgraphs. Anything outside the subset is
 * either ignored (classDef/style/comments) or stops the parse with a warning
 * (unrecognized statements), keeping the parseable prefix — the same
 * best-effort behavior mermaid.js itself shows for flowcharts.
 */

export type MermaidShape = "rect" | "rounded" | "circle" | "diamond" | "stadium";
export type MermaidEdgeStyle = "solid" | "dotted" | "thick";

export interface MermaidNode {
	id: string;
	text: string[];
	shape: MermaidShape;
}

export interface MermaidEdge {
	from: string;
	to: string;
	label?: string;
	style: MermaidEdgeStyle;
	directed: boolean;
}

export interface MermaidSubgraph {
	id: string;
	title: string;
	nodes: string[];
}

export type MermaidDirection = "TD" | "LR";

export interface MermaidGraph {
	direction: MermaidDirection;
	nodes: Map<string, MermaidNode>;
	edges: MermaidEdge[];
	subgraphs: MermaidSubgraph[];
	warnings: string[];
}

export const UNSUPPORTED_DIAGRAM_TYPES = [
	"sequenceDiagram",
	"pie",
	"gantt",
	"stateDiagram",
	"classDiagram",
	"erDiagram",
	"journey",
	"mindmap",
	"gitGraph",
	"quadrantChart",
	"sankey",
	"timeline",
	"xychart",
	"block-beta",
	"packet",
	"architecture-beta",
	"zenuml",
	"c4",
	"kanban",
	"requirementDiagram",
] as const;
function isUnsupportedDiagram(firstLine: string): boolean {
	const lower = firstLine.toLowerCase();
	return UNSUPPORTED_DIAGRAM_TYPES.some((type) => lower.startsWith(type.toLowerCase()));
}

const HEADER_RE = /^(graph|flowchart)(?:\s+(TD|TB|BT|LR|RL))?$/i;
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*/;
const SHAPES: Array<{ re: RegExp; shape: MermaidShape }> = [
	{ re: /^\(\(([^()]*)\)\)/, shape: "circle" },
	{ re: /^\[\[([^\]]*)\]\]/, shape: "rect" },
	{ re: /^\(\[([^)]*)\]\)/, shape: "stadium" },
	{ re: /^\[\(([^)]*)\)\]/, shape: "stadium" },
	{ re: /^\{([^}]*)\}/, shape: "diamond" },
	{ re: /^\(([^()]*)\)/, shape: "rounded" },
	{ re: /^\[([^\]]*)\]/, shape: "rect" },
];

const EDGE_PATTERNS: Array<{ re: RegExp; style: MermaidEdgeStyle; directed: boolean }> = [
	{ re: /^--\s*([^->][\s\S]*?)\s*-->/, style: "solid", directed: true }, // -- label -->
	{ re: /^==\s*([^=][\s\S]*?)\s*==>/, style: "thick", directed: true }, // == label ==>
	{ re: /^-\.\s*([^.-][\s\S]*?)\s*\.->/, style: "dotted", directed: true }, // -. label .->
	{ re: /^-->\|([^|]*)\|/, style: "solid", directed: true }, // -->|label|
	{ re: /^---\|([^|]*)\|/, style: "solid", directed: false }, // ---|label|
	{ re: /^==>\|([^|]*)\|/, style: "thick", directed: true },
	{ re: /^-\.->\|([^|]*)\|/, style: "dotted", directed: true },
	{ re: /^-->/, style: "solid", directed: true },
	{ re: /^---/, style: "solid", directed: false },
	{ re: /^-\.->/, style: "dotted", directed: true },
	{ re: /^==>/, style: "thick", directed: true },
	{ re: /^~->/, style: "dotted", directed: true }, // dashed shorthand (mermaid ~->)
];

function splitLines(text: string): string[] {
	return text.split(/<br\s*\/?>/i).map((line) => line.trim());
}

function parseNodeShape(source: string): { text: string; shape: MermaidShape; rest: string } | undefined {
	for (const { re, shape } of SHAPES) {
		const match = re.exec(source);
		if (match) {
			return { text: match[1] ?? "", shape, rest: source.slice(match[0].length) };
		}
	}
	return undefined;
}

function parseNode(source: string): { node: MermaidNode; rest: string } | undefined {
	const trimmed = source.trimStart();
	const idMatch = ID_RE.exec(trimmed);
	if (!idMatch) return undefined;
	const id = idMatch[0];
	const afterId = trimmed.slice(idMatch.index + id.length).trimStart();
	const shape = parseNodeShape(afterId);
	if (shape) {
		return {
			node: { id, text: splitLines(shape.text), shape: shape.shape },
			rest: shape.rest,
		};
	}
	// Bare node id (defaults to rect with the id as text)
	return { node: { id, text: [id], shape: "rect" }, rest: afterId };
}

export function parseMermaidGraph(source: string): MermaidGraph | null {
	const trimmed = source.trim();
	if (!trimmed) return null;
	const lines = trimmed.split(/\r?\n/);
	const headerLine = (lines[0] ?? "").trim();
	const header = HEADER_RE.exec(headerLine);
	if (!header) {
		if (isUnsupportedDiagram(headerLine)) {
			return null;
		}
		// A bare first statement (no graph/flowchart header) is accepted by
		// mermaid.js; accept it too, defaulting to TD.
		if (parseNode(headerLine) || lines.some((line) => /^\s*subgraph\b/.test(line))) {
			return parseBody(lines, "TD");
		}
		return null;
	}
	const rawDirection = header[2]?.toUpperCase() ?? "TD";
	const direction: MermaidDirection = rawDirection === "LR" || rawDirection === "RL" ? "LR" : "TD";
	return parseBody(lines.slice(1), direction);
}

function parseBody(lines: string[], direction: MermaidDirection): MermaidGraph {
	const nodes = new Map<string, MermaidNode>();
	const edges: MermaidEdge[] = [];
	const subgraphs: MermaidSubgraph[] = [];
	const warnings: string[] = [];

	let currentSubgraph: { id: string; title: string; nodes: string[] } | undefined;
	const nodeOrder: string[] = [];

	const addNode = (node: MermaidNode) => {
		if (!nodes.has(node.id)) {
			nodes.set(node.id, node);
			nodeOrder.push(node.id);
			if (currentSubgraph && !currentSubgraph.nodes.includes(node.id)) {
				currentSubgraph.nodes.push(node.id);
			}
		}
	};

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line || line.startsWith("%%")) continue;
		if (/^classDef\b|^class\b|^style\b|^linkStyle\b|^direction\b/.test(line)) continue;

		const subgraphStart = /^subgraph\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s*\[([^\]]*)\])?\s*$/.exec(line);
		if (subgraphStart) {
			if (currentSubgraph) {
				warnings.push("nested subgraphs are not drawn; flattening");
			} else {
				currentSubgraph = {
					id: subgraphStart[1] ?? "",
					title: (subgraphStart[2] ?? subgraphStart[1] ?? "").trim(),
					nodes: [],
				};
			}
			continue;
		}
		if (/^end\s*$/.test(line)) {
			if (currentSubgraph) {
				subgraphs.push(currentSubgraph);
				currentSubgraph = undefined;
			} else {
				warnings.push("unexpected 'end'");
			}
			continue;
		}

		// statement: NODE (EDGE NODE)*
		let cursor = line;
		let first = true;
		let fromId: string | undefined;
		let statementOk = true;
		while (cursor.length > 0 && statementOk) {
			cursor = cursor.trimStart();
			if (first) {
				const parsed = parseNode(cursor);
				if (!parsed) {
					warnings.push(`unparsed statement: ${line}`);
					statementOk = false;
					break;
				}
				addNode(parsed.node);
				fromId = parsed.node.id;
				cursor = parsed.rest;
				first = false;
				continue;
			}
			const edge = matchEdge(cursor);
			if (!edge) {
				warnings.push(`unparsed statement tail: ${line}`);
				statementOk = false;
				break;
			}
			cursor = edge.rest;
			const next = parseNode(cursor);
			if (!next) {
				warnings.push(`unparsed statement tail: ${line}`);
				statementOk = false;
				break;
			}
			addNode(next.node);
			if (fromId !== undefined) {
				edges.push({
					from: fromId,
					to: next.node.id,
					label: edge.label,
					style: edge.style,
					directed: edge.directed,
				});
			}
			fromId = next.node.id;
			cursor = next.rest;
		}
	}

	if (currentSubgraph) {
		// Unterminated subgraph: close it at EOF, keeping its collected nodes.
		subgraphs.push(currentSubgraph);
		warnings.push("unterminated subgraph closed at end of input");
	}

	return { direction, nodes, edges, subgraphs, warnings };
}

function matchEdge(
	source: string,
): { label?: string; style: MermaidEdgeStyle; directed: boolean; rest: string } | undefined {
	for (const { re, style, directed } of EDGE_PATTERNS) {
		const match = re.exec(source);
		if (match) {
			return { label: match[1]?.trim() || undefined, style, directed, rest: source.slice(match[0].length) };
		}
	}
	return undefined;
}
