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

	it("treats an unbalanced fence as code to the end", () => {
		expect(stripColorDescriptors("a ``` b [x](#role:ok)")).toBe("a ``` b [x](#role:ok)");
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
