import { parseColorDescriptor } from "@earendil-works/pi-tui";

/**
 * A markdown inline link. The inner text tolerates soft line breaks and one
 * level of balanced brackets (marked accepts both; [[x]](#role:ok) colors
 * "[x]" in the TUI, so the strip must recognize the same link). The href
 * carries no spaces. Documented limit: an unclosed "[" before a color link
 * joins into that link's inner text here, while the TUI renders the "[" as
 * text - a pathological model output, accepted for a grammar-simple strip.
 */
const INLINE_LINK_RE = /\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\]\(([^)\s]+)\)/g;

/** A masked inline-code placeholder: \u0000<index>\u0000 (text rarely holds NUL). */
const MASK_RE = /\u0000(\d+)\u0000/g;

/**
 * Strip model-facing color pseudo-links from gateway text so non-TUI surfaces
 * never show the descriptor syntax: [text](#role:ok) becomes text. Links whose
 * href is not a color descriptor stay untouched. Inline code spans and fenced
 * code blocks are left literal - a descriptor inside code is code, not a tag,
 * and the TUI renders it literally too.
 */
export function stripColorDescriptors(text: string): string {
	const masks: string[] = [];
	const mask = (value: string): string => {
		masks.push(value);
		return `\u0000${masks.length - 1}\u0000`;
	};

	// Fenced blocks first: odd ``` segments are code and stay literal. Inside
	// prose segments, mask inline code spans (odd ` segments) so a descriptor
	// inside backticks is never rewritten.
	const fenced = text.split("```").map((segment, i) => {
		if (i % 2 === 1) return segment;
		const parts = segment.split("`");
		for (let j = 1; j < parts.length; j += 2) {
			parts[j] = mask(parts[j]!);
		}
		return parts.join("`");
	});

	const stripped = fenced.map((segment, i) => {
		if (i % 2 === 1) return segment;
		return segment.replace(INLINE_LINK_RE, (match, inner: string, href: string) => {
			return parseColorDescriptor(href) ? inner : match;
		});
	});

	return stripped.join("```").replace(MASK_RE, (match, index: string) => masks[Number(index)] ?? match);
}
