/** In-repo Mermaid -> terminal Unicode art renderer (flowchart subset). */

export type {
	MermaidDirection,
	MermaidEdge,
	MermaidEdgeStyle,
	MermaidGraph,
	MermaidNode,
	MermaidShape,
	MermaidSubgraph,
} from "./parser.js";
export { parseMermaidGraph, UNSUPPORTED_DIAGRAM_TYPES } from "./parser.js";
export type { ArtRole, MermaidArtOptions, MermaidArtResult } from "./render.js";
export { renderMermaidArt } from "./render.js";

import { parseMermaidGraph } from "./parser.js";
import type { MermaidArtOptions, MermaidArtResult } from "./render.js";
import { renderMermaidArt } from "./render.js";

/** One-shot: parse then render; null when the diagram is unsupported/blank/too wide. */
export function renderMermaid(source: string, options?: MermaidArtOptions): MermaidArtResult | null {
	const graph = parseMermaidGraph(source);
	if (!graph) return null;
	return renderMermaidArt(graph, options);
}
