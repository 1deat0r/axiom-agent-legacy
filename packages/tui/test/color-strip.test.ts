import assert from "node:assert";
import { describe, it } from "node:test";
import { stripColorDescriptors } from "../src/color-strip.js";

describe("stripColorDescriptors basics", () => {
	it("strips a role foreground descriptor to its inner text", () => {
		assert.equal(stripColorDescriptors("[done](#role:ok)"), "done");
	});

	it("strips a role background descriptor to its inner text", () => {
		assert.equal(stripColorDescriptors("[careful](#bg:warn)"), "careful");
	});

	it("strips a hex foreground descriptor to its inner text", () => {
		assert.equal(stripColorDescriptors("[red](#hex:FF5555)"), "red");
	});

	it("strips a hex background descriptor to its inner text", () => {
		assert.equal(stripColorDescriptors("[dim](#hexbg:111111)"), "dim");
	});

	it("keeps the inner markdown formatting", () => {
		assert.equal(stripColorDescriptors("[**bold**](#role:error)"), "**bold**");
	});

	it("strips several descriptors on one line", () => {
		assert.equal(stripColorDescriptors("[a](#role:ok) and [b](#hex:00FF00)"), "a and b");
	});

	it("keeps a plain fragment link", () => {
		assert.equal(stripColorDescriptors("[see](#section)"), "[see](#section)");
	});

	it("keeps a real url link", () => {
		assert.equal(stripColorDescriptors("[site](https://example.com)"), "[site](https://example.com)");
	});

	it("keeps a link whose role name is unknown or uppercase", () => {
		assert.equal(stripColorDescriptors("[x](#role:WARN)"), "[x](#role:WARN)");
		assert.equal(stripColorDescriptors("[x](#role:unknown)"), "[x](#role:unknown)");
	});

	it("keeps a link whose hex value is malformed", () => {
		assert.equal(stripColorDescriptors("[x](#hex:GGGGGG)"), "[x](#hex:GGGGGG)");
		assert.equal(stripColorDescriptors("[x](#hex:12345)"), "[x](#hex:12345)");
	});
});

describe("stripColorDescriptors code literal rule", () => {
	it("leaves fenced code blocks literal", () => {
		const text = "before\n```\n[x](#role:ok) stays code\n```\nafter [y](#role:warn)";
		assert.equal(stripColorDescriptors(text), "before\n```\n[x](#role:ok) stays code\n```\nafter y");
	});

	it("leaves a descriptor inside inline code literal", () => {
		assert.equal(stripColorDescriptors("run `[x](#role:ok)` now"), "run `[x](#role:ok)` now");
	});

	it("leaves a descriptor inside inline code next to real text", () => {
		assert.equal(stripColorDescriptors("see `[x](#role:ok)` and [y](#role:warn)"), "see `[x](#role:ok)` and y");
	});

	it("keeps a color descriptor inside both inline code and a fence literal", () => {
		const text = "```\n`[x](#role:ok)`\n```\n[real](#role:ok)";
		assert.equal(stripColorDescriptors(text), "```\n`[x](#role:ok)`\n```\nreal");
	});

	it("leaves a double-backtick code span literal", () => {
		assert.equal(stripColorDescriptors("run ``[x](#role:ok)`` now"), "run ``[x](#role:ok)`` now");
	});

	it("leaves a tilde fence literal", () => {
		assert.equal(stripColorDescriptors("~~~\n[x](#role:ok)\n~~~\n[y](#role:warn)"), "~~~\n[x](#role:ok)\n~~~\ny");
	});

	it("leaves a six-backtick fence literal", () => {
		assert.equal(stripColorDescriptors("``````\n[x](#role:ok)\n``````"), "``````\n[x](#role:ok)\n``````");
	});

	it("treats an unclosed backtick as literal text and still strips the following link", () => {
		assert.equal(stripColorDescriptors("`unclosed [x](#role:ok)"), "`unclosed x");
	});

	it("treats a mid-line backtick run as an unclosed code span, so the link strips", () => {
		assert.equal(stripColorDescriptors("a ``` b [x](#role:ok)"), "a ``` b x");
	});

	it("treats an unclosed real fence as code to the end", () => {
		assert.equal(stripColorDescriptors("before\n```\n[x](#role:ok)"), "before\n```\n[x](#role:ok)");
	});

	it("leaves a backtick fence with a tilde info string literal", () => {
		assert.equal(stripColorDescriptors("```js ~ x\n[x](#role:ok)\n```"), "```js ~ x\n[x](#role:ok)\n```");
	});

	it("leaves a tilde fence with a backtick info string literal", () => {
		assert.equal(stripColorDescriptors("~~~js ` x\n[x](#role:ok)\n~~~"), "~~~js ` x\n[x](#role:ok)\n~~~");
	});

	it("mirrors marked on a fence whose closing line ends with a tab", () => {
		// marked v18 does not close a fence on a tab-terminated line, so the
		// TUI renders the whole block literally - the strip keeps it too.
		assert.equal(
			stripColorDescriptors("```\n[x](#role:ok)\n```\t\nthen [y](#role:warn)"),
			"```\n[x](#role:ok)\n```\t\nthen [y](#role:warn)",
		);
	});

	it("leaves an indented code block literal", () => {
		assert.equal(stripColorDescriptors("    [x](#role:ok)"), "    [x](#role:ok)");
	});

	it("handles CRLF fences and links", () => {
		assert.equal(
			stripColorDescriptors("```\r\n[x](#role:ok)\r\n```\r\n[y](#role:warn)"),
			"```\r\n[x](#role:ok)\r\n```\r\ny",
		);
	});
});

describe("stripColorDescriptors link-form parity", () => {
	it("strips a nested-bracket inner text the way the TUI renders it", () => {
		assert.equal(stripColorDescriptors("[[x]](#role:ok)"), "[x]");
	});

	it("strips a soft-line-break inner text", () => {
		assert.equal(stripColorDescriptors("[a\nb](#role:ok)"), "a\nb");
	});

	it("strips a titled descriptor link", () => {
		assert.equal(stripColorDescriptors('[x](#role:ok "title")'), "x");
		assert.equal(stripColorDescriptors("[x](#role:ok 'title')"), "x");
	});

	it("strips a parenthesized-title descriptor link", () => {
		assert.equal(stripColorDescriptors("[x](#role:ok (title))"), "x");
	});

	it("strips an angle-bracketed descriptor href", () => {
		assert.equal(stripColorDescriptors("[x](<#role:ok>)"), "x");
	});

	it("strips descriptor links with whitespace inside the parens", () => {
		assert.equal(stripColorDescriptors("[x]( #role:ok)"), "x");
		assert.equal(stripColorDescriptors('[x](#role:ok "title" )'), "x");
	});

	it("keeps an escaped opening bracket literal", () => {
		assert.equal(stripColorDescriptors("\\[x](#role:ok)"), "\\[x](#role:ok)");
	});

	it("keeps an escaped closing bracket literal", () => {
		assert.equal(stripColorDescriptors("[x\\](#role:ok)"), "[x\\](#role:ok)");
	});

	it("keeps an image prefix untouched", () => {
		assert.equal(stripColorDescriptors("![x](#role:ok)"), "![x](#role:ok)");
	});
});

describe("stripColorDescriptors reference parity", () => {
	it("strips a full reference link and removes its color definition line", () => {
		assert.equal(stripColorDescriptors("[x][ref]\n\n[ref]: #role:ok"), "x\n\n");
	});

	it("strips a collapsed reference link and removes its color definition line", () => {
		assert.equal(stripColorDescriptors("[ref][]\n\n[ref]: #role:ok"), "ref\n\n");
	});

	it("strips a shortcut reference link and removes its color definition line", () => {
		assert.equal(stripColorDescriptors("[ref]\n\n[ref]: #role:ok"), "ref\n\n");
	});

	it("strips a reference with a hex descriptor destination", () => {
		assert.equal(stripColorDescriptors("[c][col]\n\n[col]: #hex:FF5555"), "c\n\n");
	});

	it("removes a normal-url definition line and keeps the raw reference", () => {
		assert.equal(stripColorDescriptors("[x][ref]\n\n[ref]: https://x.com"), "[x][ref]\n\n");
	});

	it("keeps a definition that cannot interrupt a paragraph unresolved", () => {
		assert.equal(
			stripColorDescriptors("para text\n[ref]: #role:ok\n\nuse [ref]"),
			"para text\n[ref]: #role:ok\n\nuse [ref]",
		);
	});

	it("keeps a lazy list continuation definition unresolved", () => {
		assert.equal(stripColorDescriptors("- item\n[ref]: #role:ok\n\n[ref]"), "- item\n[ref]: #role:ok\n\n[ref]");
	});

	it("strips a reference inside a blockquote and removes the blockquote definition", () => {
		// The def token raw starts after the "> " prefix, so its removal leaves
		// the blockquote marker - the TUI renders the def as nothing there too.
		assert.equal(stripColorDescriptors("> [x][ref]\n>\n> [ref]: #role:ok"), "> x\n>\n> ");
	});

	it("honors first-definition-wins for duplicate definitions", () => {
		// marked resolves the reference to the first (URL) definition, keeps
		// that def token, and drops the duplicate color definition from the
		// token stream. The losing color def line therefore survives as text;
		// nothing is mangled. Documented divergence in ADR-0050.
		assert.equal(
			stripColorDescriptors("[x][ref]\n\n[ref]: https://x.com\n[ref]: #role:ok"),
			"[x][ref]\n\n[ref]: #role:ok",
		);
	});

	it("collapses label whitespace the way marked does", () => {
		assert.equal(stripColorDescriptors("[x][my  ref]\n\n[my ref]: #role:ok"), "x\n\n");
	});

	it("leaves a blockquote tilde fence literal and strips after it", () => {
		assert.equal(
			stripColorDescriptors("> ~~~\n> [x](#role:ok)\n> ~~~\n> [y](#role:warn)"),
			"> ~~~\n> [x](#role:ok)\n> ~~~\n> y",
		);
	});
});
