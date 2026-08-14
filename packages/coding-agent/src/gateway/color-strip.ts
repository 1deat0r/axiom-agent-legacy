import { parseColorDescriptor } from "@earendil-works/pi-tui";

/**
 * A markdown inline link. The inner text tolerates soft line breaks and one
 * level of balanced brackets, the href may be angle-bracketed, whitespace may
 * surround the href and title, and an optional quoted or parenthesized title
 * may follow - marked accepts all of these, and the TUI colors them, so the
 * strip must recognize the same link. An escaped opening bracket (\\[) is a
 * literal, not a link.
 */
const INLINE_LINK_RE =
	/(?<!\\)\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\]\(\s*(<[^>\s]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

/** A masked code placeholder: \u0000<index>\u0000 (text rarely holds NUL). */
const MASK_RE = /\u0000(\d+)\u0000/g;

/**
 * Fence openers mirror CommonMark: a line that starts (after at most three
 * spaces) with a ``` run (info string may not contain backticks) or a ~~~
 * run (info string may contain anything). A closing fence is a line whose run
 * has the same character and at least the opening length, then only spaces or
 * tabs. An unclosed fence runs to the end of the text - marked does the same.
 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}[^`]*|~{3,}.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** A link reference definition line: [label]: destination with optional title. */
const DEFINITION_RE = /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>\s]+>|[^\s]+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gm;

/** A full [text][label] or collapsed [label][] reference. */
const FULL_REF_RE = /(?<!\\)\[([^\]]*)\]\[([^\]]*)\]/g;

/** A shortcut [label] reference that is not part of a larger link form. */
const SHORTCUT_REF_RE = /(?<!\\)\[([^\]]+)\](?![([])/g;

function cleanHref(href: string): string {
	return href.startsWith("<") && href.endsWith(">") ? href.slice(1, -1) : href;
}

/**
 * Mask fenced code blocks line by line (CommonMark fence pairing).
 */
function maskFences(text: string, mask: (value: string) => string): string {
	const lines = text.split("\n");
	let open: { char: string; length: number } | null = null;
	const out: string[] = [];
	for (const line of lines) {
		if (open) {
			const closing = line.match(FENCE_CLOSE_RE);
			if (closing && closing[1]![0] === open.char && closing[1]!.length >= open.length) {
				open = null;
			}
			out.push(mask(line));
			continue;
		}
		const opening = line.match(FENCE_OPEN_RE);
		if (opening) {
			const run = opening[1]!;
			open = { char: run[0]!, length: run.length };
			out.push(mask(line));
		} else {
			out.push(line);
		}
	}
	return out.join("\n");
}

/**
 * Mask inline code spans. A backtick run of length n opens a span and a run of
 * exactly n closes it (CommonMark); an unclosed run is literal text, so the
 * text after it is still prose that marked parses. Runs of other lengths
 * inside the span are content.
 */
function maskCodeSpans(text: string, mask: (value: string) => string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (text[i] !== "`") {
			out += text[i];
			i++;
			continue;
		}
		let run = 0;
		while (i + run < text.length && text[i + run] === "`") run++;
		let closed = false;
		let j = i + run;
		while (j < text.length) {
			if (text[j] === "`") {
				let r = 0;
				while (j + r < text.length && text[j + r] === "`") r++;
				if (r === run) {
					out += mask(text.slice(i, j + run));
					i = j + run;
					closed = true;
					break;
				}
				j += r;
			} else {
				j++;
			}
		}
		if (!closed) {
			out += text.slice(i, i + run);
			i += run;
		}
	}
	return out;
}

/**
 * Strip model-facing color pseudo-links from gateway text so non-TUI surfaces
 * never show the descriptor syntax: [text](#role:ok) becomes text. Links whose
 * href is not a color descriptor stay untouched. Reference-style links whose
 * definition is a color descriptor are reduced to their text and the
 * definition line is removed. Fenced code blocks (backtick and tilde, any run
 * length) and inline code spans (any backtick run length) are left literal -
 * a descriptor inside code is code, not a tag, and the TUI renders code
 * literally too.
 */
export function stripColorDescriptors(text: string): string {
	const masks: string[] = [];
	const mask = (value: string): string => {
		masks.push(value);
		return `\u0000${masks.length - 1}\u0000`;
	};

	// Fences first, then code spans inside the prose that remains.
	const fenced = maskFences(text, mask);
	const codeMasked = maskCodeSpans(fenced, mask);

	// Color reference definitions: drop the definition line, remember the label.
	const colorLabels = new Set<string>();
	const noDefinitions = codeMasked.replace(DEFINITION_RE, (match, label: string, href: string) => {
		if (parseColorDescriptor(cleanHref(href))) {
			colorLabels.add(label.trim().toLowerCase());
			return "";
		}
		return match;
	});

	// Full and collapsed references to color labels reduce to their text.
	const fullRefs = noDefinitions.replace(FULL_REF_RE, (match, text: string, label: string) => {
		if (label === "") return colorLabels.has(text.trim().toLowerCase()) ? text : match;
		return colorLabels.has(label.trim().toLowerCase()) ? text : match;
	});

	// Shortcut references to color labels reduce to their text.
	const shortcuts = fullRefs.replace(SHORTCUT_REF_RE, (match, text: string) => {
		return colorLabels.has(text.trim().toLowerCase()) ? text : match;
	});

	const stripped = shortcuts.replace(INLINE_LINK_RE, (match, inner: string, href: string) => {
		return parseColorDescriptor(cleanHref(href)) ? inner : match;
	});

	return stripped.replace(MASK_RE, (match, index: string) => masks[Number(index)] ?? match);
}
