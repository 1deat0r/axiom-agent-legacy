import type { Marked, Token, Tokens } from "marked";
import { parseColorDescriptor } from "./color-descriptor.js";
import { pickMarkdownParser } from "./components/markdown.js";

/** The raw source of a token, with a text fallback for tokens without raw. */
function rawOf(token: Token): string {
	if ("raw" in token && typeof token.raw === "string") return token.raw;
	if ("text" in token && typeof token.text === "string") return token.text;
	return "";
}

/**
 * The child tokens that can hide a color link, in source order. List items
 * and table cells hold their content in items/header/rows instead of a
 * top-level tokens field.
 */
function childrenOf(token: Token): Token[] {
	if ("tokens" in token && token.tokens) return token.tokens;
	if (token.type === "list") return (token as Tokens.List).items;
	if (token.type === "table") {
		const table = token as Tokens.Table;
		const cells = [...table.header, ...table.rows.flat()];
		return cells.flatMap((cell) => ("tokens" in cell && cell.tokens ? cell.tokens : []));
	}
	return [];
}

/**
 * Emit a token: color links reduce to their inner raw text, definition lines
 * to nothing, and every other token to its source. For a token with children,
 * the children are spliced into the parent's raw in source order with a
 * cursor that always advances, so an identical raw string that appears
 * earlier inside preserved content (e.g. a code span quoting the descriptor)
 * can never be hit instead of the real child.
 */
function emitToken(token: Token): string {
	if (token.type === "link") {
		const link = token as Tokens.Link;
		if (parseColorDescriptor(link.href)) {
			return (link.tokens ?? []).map(rawOf).join("");
		}
	}
	if (token.type === "def") return "";

	const children = childrenOf(token);
	if (children.length === 0) return rawOf(token);

	const raw = rawOf(token);
	let cursor = 0;
	let out = "";
	for (const child of children) {
		const childRaw = rawOf(child);
		const at = raw.indexOf(childRaw, cursor);
		if (at === -1) continue;
		out += raw.slice(cursor, at);
		out += emitToken(child);
		cursor = at + childRaw.length;
	}
	out += raw.slice(cursor);
	return out;
}

/**
 * Strip model-facing color pseudo-links from markdown text so non-TUI
 * surfaces never show the descriptor syntax: [text](#role:ok) becomes text.
 * The text is normalized exactly like the TUI renderer's own lexing path
 * (tabs to three spaces, CRLF to LF) and lexed with the renderer's own
 * parser, so what the TUI treats as a color link or as literal code is what
 * this strips or keeps - parity by construction. Links whose href is not a
 * color descriptor and all other source stay as written, modulo the same
 * normalization the TUI applies.
 */
export function stripColorDescriptors(text: string): string {
	const normalized = text.replace(/\t/g, "   ").replace(/\r\n/g, "\n");
	const parser: Marked = pickMarkdownParser(normalized);
	const tokens = parser.lexer(normalized) as Token[];
	return tokens.map(emitToken).join("");
}
