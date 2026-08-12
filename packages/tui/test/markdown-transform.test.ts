import { describe, expect, it } from "vitest";
import { Markdown } from "../src/components/markdown.js";

const plainTheme = {
	heading: (t: string) => t,
	link: (t: string) => t,
	linkUrl: (t: string) => t,
	code: (t: string) => t,
	codeBlock: (t: string) => t,
	codeBlockBorder: (t: string) => t,
	quote: (t: string) => t,
	quoteBorder: (t: string) => t,
	hr: (t: string) => t,
	listBullet: (t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	strikethrough: (t: string) => t,
	underline: (t: string) => t,
};

describe("Markdown transform hook", () => {
	it("applies the transform before parsing, with width", () => {
		const seen: number[] = [];
		const md = new Markdown("hello [[world]]", 1, 0, plainTheme, undefined, (text, width) => {
			seen.push(width);
			return text.replace("[[world]]", "there");
		});
		const lines = md.render(40);
		expect(lines.join("\n")).toContain("hello there");
		expect(seen).toEqual([40]);
	});

	it("re-renders when width changes (transform is width-aware)", () => {
		let widthSeen = 0;
		const md = new Markdown("abc", 0, 0, plainTheme, undefined, (_text, width) => {
			widthSeen = width;
			return `w=${width}`;
		});
		md.render(10);
		expect(widthSeen).toBe(10);
		md.render(25);
		expect(widthSeen).toBe(25);
	});

	it("leaves text untouched without a transform", () => {
		const md = new Markdown("plain", 0, 0, plainTheme);
		expect(md.render(10).join("\n")).toContain("plain");
	});
});
