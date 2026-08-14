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

describe("Markdown standalone hex literals", () => {
	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("colors a standalone hex literal with its own color and a swatch chip", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("shade #50fa7b here", 0, 0, theme);

		const lines = markdown.render(80);
		const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

		assert.deepStrictEqual(calls.colored, [
			{ text: "#50FA7B", color: { channel: "fg", kind: "hex", value: "50FA7B" } },
			{ text: "■", color: { channel: "fg", kind: "hex", value: "50FA7B" } },
		]);
		assert.deepStrictEqual(calls.backgrounded, []);
		assert.ok(plain.includes("shade"), "leading text is rendered");
		assert.ok(plain.includes("here"), "trailing text is rendered");
	});

	it("colors multiple standalone hex literals on one line", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("#FF5555 and #50fa7b", 0, 0, theme);

		markdown.render(80);

		assert.deepStrictEqual(calls.colored, [
			{ text: "#FF5555", color: { channel: "fg", kind: "hex", value: "FF5555" } },
			{ text: "■", color: { channel: "fg", kind: "hex", value: "FF5555" } },
			{ text: "#50FA7B", color: { channel: "fg", kind: "hex", value: "50FA7B" } },
			{ text: "■", color: { channel: "fg", kind: "hex", value: "50FA7B" } },
		]);
	});

	it("skips a hex literal embedded in a word", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("size#50fa7b", 0, 0, theme);

		markdown.render(80);

		assert.deepStrictEqual(calls.colored, []);
	});

	it("skips a hex literal inside inline code", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("run `echo #50fa7b` now", 0, 0, theme);

		markdown.render(80);

		assert.deepStrictEqual(calls.colored, []);
	});

	it("skips a three digit shorthand", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("#5f7", 0, 0, theme);

		markdown.render(80);

		assert.deepStrictEqual(calls.colored, []);
	});

	it("keeps the literal as plain text when the theme has no colored hook", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const markdown = new Markdown("shade #50fa7b here", 0, 0, defaultMarkdownTheme);

		const lines = markdown.render(80);
		const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

		assert.ok(plain.includes("#50fa7b"), "literal stays plain");
		assert.ok(!plain.includes("■"), "no swatch chip without a colored hook");
	});

	it("composes with bold around the literal", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("**#50fa7b**", 0, 0, theme);

		markdown.render(80);

		assert.deepStrictEqual(calls.colored, [
			{ text: "#50FA7B", color: { channel: "fg", kind: "hex", value: "50FA7B" } },
			{ text: "■", color: { channel: "fg", kind: "hex", value: "50FA7B" } },
		]);
	});
});

describe("Markdown color channel composition", () => {
	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("composes bold inside a role colored link", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("[**bold**](#role:ok)", 0, 0, theme);

		const lines = markdown.render(80);
		const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

		assert.equal(calls.colored.length, 1);
		assert.equal(calls.colored[0]!.color.channel, "fg");
		assert.equal(calls.colored[0]!.color.kind, "role");
		assert.equal(calls.colored[0]!.color.value, "ok");
		assert.ok(calls.colored[0]!.text.includes("bold"), "bold inner text is colored");
		assert.deepStrictEqual(calls.backgrounded, []);
		assert.ok(plain.includes("bold"), "inner text is rendered");
	});
});

describe("Markdown hex literal ambient style and boundaries", () => {
	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("keeps a heading style on the literal and the swatch", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("## Result #50fa7b ok", 0, 0, theme);

		const lines = markdown.render(80);

		assert.equal(calls.colored.length, 2);
		assert.deepEqual(calls.colored[0]!.color, { channel: "fg", kind: "hex", value: "50FA7B" });
		assert.deepEqual(calls.colored[1]!.color, { channel: "fg", kind: "hex", value: "50FA7B" });
		// The ambient heading style (bold cyan) survives inside the colored span.
		assert.ok(calls.colored[0]!.text.includes("\x1b[1m\x1b[36m"), "heading weight and color precede the literal");
		assert.ok(calls.colored[0]!.text.includes("#50FA7B"), "literal is colored");
		assert.ok(calls.colored[1]!.text.includes("■"), "swatch is colored");
		assert.ok(lines.length > 0, "heading renders");
	});

	it("skips a URL fragment hex token", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("http://x.com/#aabbcc", 0, 0, theme);

		markdown.render(80);

		assert.deepStrictEqual(calls.colored, []);
	});

	it("falls back to inner text for a background descriptor when the theme has no backgrounded hook", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const calls: Array<{ text: string }> = [];
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			colored: (text: string) => {
				calls.push({ text });
				return text;
			},
		};
		const markdown = new Markdown("[dim](#bg:info)", 0, 0, theme);

		const lines = markdown.render(80);
		const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

		assert.deepStrictEqual(calls, []);
		assert.ok(plain.includes("dim"), "inner text still rendered");
	});

	it("composes strikethrough inside a role colored link", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("[~~gone~~](#role:muted)", 0, 0, theme);

		const lines = markdown.render(80);
		const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

		assert.equal(calls.colored.length, 1);
		assert.equal(calls.colored[0]!.color.value, "muted");
		assert.ok(calls.colored[0]!.text.includes("gone"), "struck text is colored");
		assert.ok(plain.includes("gone"), "inner text is rendered");
	});
});

describe("Markdown hex literal word boundaries", () => {
	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("skips a literal glued to a word", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("foo#aabbcc #aabbccx x.com#aabbcc x.com/foo#aabbcc", 0, 0, theme);

		markdown.render(80);

		assert.deepStrictEqual(calls.colored, []);
	});

	it("colors a literal after punctuation and before punctuation", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const { theme, calls } = makeCapturingTheme();
		const markdown = new Markdown("(#aabbcc) and #aabbcc.", 0, 0, theme);

		markdown.render(80);

		assert.equal(calls.colored.length, 4);
	});
});
