import { parseColorDescriptor } from "@earendil-works/pi-tui";

/**
 * A markdown inline link. The inner text tolerates soft line breaks and one
 * level of balanced brackets, the href may be angle-bracketed, and an optional
 * title may follow - marked accepts all of these, and the TUI colors them, so
 * the strip must recognize the same link. Documented limit: an unclosed "["
 * before a color link joins into that link's inner text here, while the TUI
 * renders the "[" as text - a pathological model output, accepted for a
 * grammar-simple strip.
 */
const INLINE_LINK_RE = /\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\]\((<[^>\s]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;

/** A masked code placeholder: \u0000<index>\u0000 (text rarely holds NUL). */
const MASK_RE = /\u0000(\d+)\u0000/g;

/**
 * Mask fenced code blocks line by line. A fence is a line that starts (after
 * at most three spaces) with a ``` or ~~~ run of length >= 3; a closing fence
 * is a line whose run has the same character and at least the opening length.
 * An unclosed fence runs to the end of the text - marked does the same.
 */
function maskFences(text: string, mask: (value: string) => string): string {
	const lines = text.split("\n");
	let open: { char: string; length: number } | null = null;
	const out: string[] = [];
	for (const line of lines) {
		if (open) {
			const closing = line.match(/^ {0,3}(`{3,}|~{3,}) *$/);
			if (closing && closing[1]![0] === open.char && closing[1]!.length >= open.length) {
				open = null;
			}
			out.push(mask(line));
			continue;
		}
		const opening = line.match(/^ {0,3}(`{3,}|~{3,})[^`~]*$/);
		if (opening) {
			open = { char: opening[1]![0]!, length: opening[1]!.length };
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
 * href is not a color descriptor stay untouched. Fenced code blocks (backtick
 * and tilde, any run length) and inline code spans (any backtick run length)
 * are left literal - a descriptor inside code is code, not a tag, and the TUI
 * renders code literally too.
 */
export function stripColorDescriptors(text: string): string {
	const masks: string[] = [];
	const mask = (value: string): string => {
		masks.push(value);
		return `\u0000${masks.length - 1}\u0000`;
	};

	const fenced = maskFences(text, mask);
	const codeMasked = maskCodeSpans(fenced, mask);

	const stripped = codeMasked.replace(INLINE_LINK_RE, (match, inner: string, href: string) => {
		const cleanHref = href.startsWith("<") && href.endsWith(">") ? href.slice(1, -1) : href;
		return parseColorDescriptor(cleanHref) ? inner : match;
	});

	return stripped.replace(MASK_RE, (match, index: string) => masks[Number(index)] ?? match);
}
