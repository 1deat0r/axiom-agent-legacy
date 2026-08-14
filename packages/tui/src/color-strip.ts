import type { Token, Tokens } from "marked";
import { parseColorDescriptor } from "./color-descriptor.js";
import { pickMarkdownParser } from "./components/markdown.js";

/** The raw source of a token, with a text fallback for tokens without raw. */
function rawOf(token: Token): string {
	if ("raw" in token && typeof token.raw === "string") return token.raw;
	if ("text" in token && typeof token.text === "string") return token.text;
	return "";
}

interface Edit {
	raw: string;
	replacement: string;
}

/**
 * Collect the source spans to rewrite, in document order: a color link
 * reduces to its inner raw text, and a link reference definition line is
 * removed (the TUI renders definitions as nothing). Everything else is left
 * byte-identical.
 */
function collectEdits(tokens: Token[], edits: Edit[]): void {
	for (const token of tokens) {
		if (token.type === "link") {
			const link = token as Tokens.Link;
			if (parseColorDescriptor(link.href)) {
				const inner = (link.tokens ?? []).map(rawOf).join("");
				edits.push({ raw: link.raw, replacement: inner });
				continue;
			}
		}
		if (token.type === "def") {
			const def = token as Tokens.Def;
			edits.push({ raw: def.raw, replacement: "" });
			continue;
		}
		if ("tokens" in token && token.tokens && token.tokens.length > 0) {
			collectEdits(token.tokens, edits);
		}
	}
}

/**
 * Strip model-facing color pseudo-links from markdown text so non-TUI
 * surfaces never show the descriptor syntax: [text](#role:ok) becomes text.
 * The strip lexes with the exact parser the TUI renderer uses, so what the
 * TUI treats as a color link or as literal code is what this strips or
 * keeps - parity by construction, not by reimplemented grammar. Links whose
 * href is not a color descriptor, inline and fenced code, and all other
 * source stay byte-identical.
 */
export function stripColorDescriptors(text: string): string {
	const parser = pickMarkdownParser(text);
	const tokens = parser.lexer(text) as Token[];
	const edits: Edit[] = [];
	collectEdits(tokens, edits);

	if (edits.length === 0) return text;

	let out = "";
	let cursor = 0;
	for (const edit of edits) {
		const at = text.indexOf(edit.raw, cursor);
		if (at === -1) continue;
		out += text.slice(cursor, at) + edit.replacement;
		cursor = at + edit.raw.length;
	}
	out += text.slice(cursor);
	return out;
}
