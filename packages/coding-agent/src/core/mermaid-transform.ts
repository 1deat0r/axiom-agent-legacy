/**
 * Markdown transform that turns ```mermaid fences into themed Unicode art
 * (via the in-repo mermaid-art renderer). Wired into the Markdown component
 * for assistant/user text blocks; disabled, too-wide, unsupported, or
 * unparseable diagrams fall back to the raw fenced source.
 */

import type { ArtRole } from "./mermaid-art/index.js";
import { renderMermaid } from "./mermaid-art/index.js";

export interface MermaidTransformTheme {
	border: (text: string) => string;
	edge: (text: string) => string;
	title: (text: string) => string;
}

export interface MermaidTransformOptions {
	/** When false, the source fence is left untouched. */
	enabled: boolean;
	/** Terminal width in cells; art wider than this is left as source. */
	maxWidth: number;
	theme: MermaidTransformTheme;
}

const FENCE_RE = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g;

export function transformMermaidBlocks(text: string, options: MermaidTransformOptions): string {
	if (!options.enabled) return text;
	return text.replace(FENCE_RE, (match, source: string) => {
		const art = renderMermaid(source, { maxWidth: Math.max(1, options.maxWidth - 2) });
		if (!art) return match;
		return art.lines
			.map((line, index) => styleMermaidLine(line, art.roles[index] ?? "text", options.theme))
			.join("\n");
	});
}

function styleMermaidLine(line: string, role: ArtRole, theme: MermaidTransformTheme): string {
	if (line.trim() === "") return line;
	switch (role) {
		case "border":
			return theme.border(line);
		case "edge":
			return theme.edge(line);
		case "title":
			return theme.title(line);
		default:
			return line;
	}
}
