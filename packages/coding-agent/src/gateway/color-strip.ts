import { parseColorDescriptor } from "@earendil-works/pi-tui";

/** A markdown inline link whose href carries no spaces (fragments, urls). */
const INLINE_LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/**
 * Strip model-facing color pseudo-links from gateway text so non-TUI surfaces
 * never show the descriptor syntax: [text](#role:ok) becomes text. Links whose
 * href is not a color descriptor stay untouched. Fenced code blocks are left
 * literal - a descriptor inside a fence is code, not a tag (the TUI renders it
 * literally too).
 */
export function stripColorDescriptors(text: string): string {
	const segments = text.split("```");
	for (let i = 0; i < segments.length; i += 2) {
		segments[i] = segments[i]!.replace(INLINE_LINK_RE, (match, inner: string, href: string) => {
			return parseColorDescriptor(href) ? inner : match;
		});
	}
	return segments.join("```");
}
