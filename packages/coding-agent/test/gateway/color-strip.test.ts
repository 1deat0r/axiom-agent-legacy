import { describe, expect, it } from "vitest";
import { stripColorDescriptors } from "../../src/gateway/color-strip.js";

describe("stripColorDescriptors", () => {
	it("strips a role foreground descriptor to its inner text", () => {
		expect(stripColorDescriptors("[done](#role:ok)")).toBe("done");
	});

	it("strips a role background descriptor to its inner text", () => {
		expect(stripColorDescriptors("[careful](#bg:warn)")).toBe("careful");
	});

	it("strips a hex foreground descriptor to its inner text", () => {
		expect(stripColorDescriptors("[red](#hex:FF5555)")).toBe("red");
	});

	it("strips a hex background descriptor to its inner text", () => {
		expect(stripColorDescriptors("[dim](#hexbg:111111)")).toBe("dim");
	});

	it("keeps the inner markdown formatting", () => {
		expect(stripColorDescriptors("[**bold**](#role:error)")).toBe("**bold**");
	});

	it("strips several descriptors on one line", () => {
		expect(stripColorDescriptors("[a](#role:ok) and [b](#hex:00FF00)")).toBe("a and b");
	});

	it("keeps a plain fragment link", () => {
		expect(stripColorDescriptors("[see](#section)")).toBe("[see](#section)");
	});

	it("keeps a real url link", () => {
		expect(stripColorDescriptors("[site](https://example.com)")).toBe("[site](https://example.com)");
	});

	it("keeps a link whose role name is unknown or uppercase", () => {
		expect(stripColorDescriptors("[x](#role:WARN)")).toBe("[x](#role:WARN)");
		expect(stripColorDescriptors("[x](#role:unknown)")).toBe("[x](#role:unknown)");
	});

	it("keeps a link whose hex value is malformed", () => {
		expect(stripColorDescriptors("[x](#hex:GGGGGG)")).toBe("[x](#hex:GGGGGG)");
		expect(stripColorDescriptors("[x](#hex:12345)")).toBe("[x](#hex:12345)");
	});

	it("leaves fenced code blocks literal", () => {
		const text = "before\n```\n[x](#role:ok) stays code\n```\nafter [y](#role:warn)";
		expect(stripColorDescriptors(text)).toBe("before\n```\n[x](#role:ok) stays code\n```\nafter y");
	});

	it("treats a mid-line backtick run as an unclosed code span, so the link strips", () => {
		expect(stripColorDescriptors("a ``` b [x](#role:ok)")).toBe("a ``` b x");
	});

	it("treats an unclosed real fence as code to the end", () => {
		expect(stripColorDescriptors("before\n```\n[x](#role:ok)")).toBe("before\n```\n[x](#role:ok)");
	});
});

describe("stripColorDescriptors surface parity", () => {
	it("leaves a descriptor inside inline code literal", () => {
		expect(stripColorDescriptors("run `[x](#role:ok)` now")).toBe("run `[x](#role:ok)` now");
	});

	it("leaves a descriptor inside inline code next to real text", () => {
		expect(stripColorDescriptors("see `[x](#role:ok)` and [y](#role:warn)")).toBe("see `[x](#role:ok)` and y");
	});

	it("strips a nested-bracket inner text the way the TUI renders it", () => {
		expect(stripColorDescriptors("[[x]](#role:ok)")).toBe("[x]");
	});

	it("strips a soft-line-break inner text", () => {
		expect(stripColorDescriptors("[a\nb](#role:ok)")).toBe("a\nb");
	});

	it("leaves inline code intact across many backticks", () => {
		expect(stripColorDescriptors("`a` [x](#role:ok) `b`")).toBe("`a` x `b`");
	});

	it("keeps a color descriptor inside both inline code and a fence literal", () => {
		const text = "```\n`[x](#role:ok)`\n```\n[real](#role:ok)";
		expect(stripColorDescriptors(text)).toBe("```\n`[x](#role:ok)`\n```\nreal");
	});
});

describe("stripColorDescriptors CommonMark parity", () => {
	it("leaves a double-backtick code span literal", () => {
		expect(stripColorDescriptors("run ``[x](#role:ok)`` now")).toBe("run ``[x](#role:ok)`` now");
	});

	it("leaves a tilde fence literal", () => {
		expect(stripColorDescriptors("~~~\n[x](#role:ok)\n~~~\n[y](#role:warn)")).toBe("~~~\n[x](#role:ok)\n~~~\ny");
	});

	it("leaves a six-backtick fence literal", () => {
		expect(stripColorDescriptors("``````\n[x](#role:ok)\n``````")).toBe("``````\n[x](#role:ok)\n``````");
	});

	it("treats an unclosed backtick as literal text and still strips the following link", () => {
		expect(stripColorDescriptors("`unclosed [x](#role:ok)")).toBe("`unclosed x");
	});

	it("strips a titled descriptor link", () => {
		expect(stripColorDescriptors('[x](#role:ok "title")')).toBe("x");
		expect(stripColorDescriptors("[x](#role:ok 'title')")).toBe("x");
	});

	it("strips an angle-bracketed descriptor href", () => {
		expect(stripColorDescriptors("[x](<#role:ok>)")).toBe("x");
	});

	it("keeps a titled non-descriptor link", () => {
		expect(stripColorDescriptors('[x](#section "title")')).toBe('[x](#section "title")');
	});
});

describe("stripColorDescriptors reference and whitespace parity", () => {
	it("strips a full reference link and removes its color definition line", () => {
		expect(stripColorDescriptors("[x][ref]\n\n[ref]: #role:ok")).toBe("x\n\n");
	});

	it("strips a collapsed reference link and removes its color definition line", () => {
		expect(stripColorDescriptors("[ref][]\n\n[ref]: #role:ok")).toBe("ref\n\n");
	});

	it("strips a shortcut reference link and removes its color definition line", () => {
		expect(stripColorDescriptors("[ref]\n\n[ref]: #role:ok")).toBe("ref\n\n");
	});

	it("strips a reference with a hex descriptor destination", () => {
		expect(stripColorDescriptors("[c][col]\n\n[col]: #hex:FF5555")).toBe("c\n\n");
	});

	it("keeps a reference whose definition is a normal url", () => {
		expect(stripColorDescriptors("[x][ref]\n\n[ref]: https://x.com")).toBe("[x][ref]\n\n[ref]: https://x.com");
	});

	it("strips a parenthesized-title descriptor link", () => {
		expect(stripColorDescriptors("[x](#role:ok (title))")).toBe("x");
	});

	it("strips descriptor links with whitespace inside the parens", () => {
		expect(stripColorDescriptors("[x]( #role:ok)")).toBe("x");
		expect(stripColorDescriptors('[x](#role:ok "title" )')).toBe("x");
	});

	it("keeps an escaped opening bracket literal", () => {
		expect(stripColorDescriptors("\\[x](#role:ok)")).toBe("\\[x](#role:ok)");
	});

	it("leaves a backtick fence with a tilde info string literal", () => {
		expect(stripColorDescriptors("```js ~ x\n[x](#role:ok)\n```")).toBe("```js ~ x\n[x](#role:ok)\n```");
	});

	it("leaves a tilde fence with a backtick info string literal", () => {
		expect(stripColorDescriptors("~~~js ` x\n[x](#role:ok)\n~~~")).toBe("~~~js ` x\n[x](#role:ok)\n~~~");
	});

	it("closes a fence whose closing line ends with a tab", () => {
		expect(stripColorDescriptors("```\n[x](#role:ok)\n```\t\nthen [y](#role:warn)")).toBe(
			"```\n[x](#role:ok)\n```\t\nthen y",
		);
	});
});
