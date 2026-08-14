import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.js";
import type { ColorDescriptor, MarkdownTheme } from "../src/index.js";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.js";
import { defaultMarkdownTheme } from "./test-themes.js";

interface CapturedColorCalls {
	colored: Array<{ text: string; color: ColorDescriptor }>;
	backgrounded: Array<{ text: string; color: ColorDescriptor }>;
	link: string[];
	linkUrl: string[];
}

/**
 * Theme that records color-descriptor calls and renders identity output.
 * link/linkUrl are recorded so plain links can be asserted against the same theme.
 */
function makeCapturingTheme(): { theme: MarkdownTheme; calls: CapturedColorCalls } {
	const calls: CapturedColorCalls = { colored: [], backgrounded: [], link: [], linkUrl: [] };
	const theme: MarkdownTheme = {
		...defaultMarkdownTheme,
		colored: (text: string, color: ColorDescriptor) => {
			calls.colored.push({ text, color });
			return text;
		},
		backgrounded: (text: string, color: ColorDescriptor) => {
			calls.backgrounded.push({ text, color });
			return text;
		},
		link: (text: string) => {
			calls.link.push(text);
			return text;
		},
		linkUrl: (text: string) => {
			calls.linkUrl.push(text);
			return text;
		},
		underline: (text: string) => text,
	};
	return { theme, calls };
}

describe("Markdown color descriptors", () => {
	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("renders a role foreground descriptor via theme.colored", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("[text](#role:warn)", 0, 0, theme);

		const lines = markdown.render(80);
		const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

		assert.deepStrictEqual(calls.colored, [{ text: "text", color: { channel: "fg", kind: "role", value: "warn" } }]);
		assert.deepStrictEqual(calls.backgrounded, []);
		assert.ok(plain.includes("text"), "inner text is rendered");
	});

	it("renders a role background descriptor via theme.backgrounded", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("[text](#bg:ok)", 0, 0, theme);

		const lines = markdown.render(80);
		const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

		assert.deepStrictEqual(calls.backgrounded, [
			{ text: "text", color: { channel: "bg", kind: "role", value: "ok" } },
		]);
		assert.deepStrictEqual(calls.colored, []);
		assert.ok(plain.includes("text"), "inner text is rendered");
	});

	it("keeps plain fragment links as normal hyperlinks", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("[x](#section)", 0, 0, theme);

		const lines = markdown.render(80);
		const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

		assert.ok(calls.link.length > 0, "theme.link is called for the plain link");
		assert.ok(
			calls.linkUrl.some((url) => url.includes("#section")),
			"URL is shown for the plain link",
		);
		assert.deepStrictEqual(calls.colored, []);
		assert.deepStrictEqual(calls.backgrounded, []);
		assert.ok(plain.includes("x"), "link text is rendered");
		assert.ok(plain.includes("#section"), "URL is rendered");
	});
});
