import { decodeHtmlEntities, stripTagsInline } from "./web-shared.js";

export interface MarkdownPage {
	title: string;
	markdown: string;
}

function extractTitle(html: string): string {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? decodeHtmlEntities(stripTagsInline(match[1])) : "";
}

/**
 * Minimal in-repo HTML to markdown converter. No dependencies. Defensive:
 * malformed HTML degrades to text, never throws. Script, style, and other
 * active content is removed before conversion.
 */
export function htmlToMarkdown(html: string): MarkdownPage {
	const title = extractTitle(html);
	let s = html;
	// Active and non-content blocks go first.
	s = s.replace(/<(script|style|noscript|svg|template|head)[^>]*>[\s\S]*?<\/\1>/gi, " ");
	const body = s.match(/<body[^>]*>([\s\S]*)<\/body>/i);
	if (body) {
		s = body[1];
	}
	// Links before the generic tag strip, so text and href survive.
	s = s.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
		const text = stripTagsInline(inner);
		return text ? `[${text}](${href})` : "";
	});
	s = s.replace(
		/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
		(_m, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${stripTagsInline(inner)}\n\n`,
	);
	s = s.replace(
		/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
		(_m, inner: string) => `\n\n> ${stripTagsInline(inner)}\n\n`,
	);
	s = s.replace(
		/<pre[^>]*>([\s\S]*?)<\/pre>/gi,
		(_m, inner: string) => `\n\n\`\`\`\n${stripTagsInline(inner)}\n\`\`\`\n\n`,
	);
	s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${stripTagsInline(inner)}`);
	s = s.replace(/<\/(p|div|section|article|tr|h[1-6])>/gi, "\n\n");
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<[^>]+>/g, " ");
	s = decodeHtmlEntities(s);
	s = s
		.replace(/[ \t]+/g, " ")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title, markdown: s };
}
