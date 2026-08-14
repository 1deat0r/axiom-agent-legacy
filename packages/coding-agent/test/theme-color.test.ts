import { rgbTo256 } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getMarkdownTheme,
	loadThemeFromPath,
	roleHex,
	setThemeInstance,
} from "../src/modes/interactive/theme/theme.js";

const DARK_THEME_PATH = new URL("../src/modes/interactive/theme/dark.json", import.meta.url).pathname;

function useThemeMode(mode: "truecolor" | "256color"): void {
	setThemeInstance(loadThemeFromPath(DARK_THEME_PATH, mode));
}

describe("roleHex", () => {
	it("returns the exact hex for each role", () => {
		expect(roleHex("error")).toBe("#FF5555");
		expect(roleHex("warn")).toBe("#FFB86C");
		expect(roleHex("ok")).toBe("#50FA7B");
		expect(roleHex("info")).toBe("#8BE9FD");
		expect(roleHex("accent")).toBe("#BD93F9");
		expect(roleHex("muted")).toBe("#6272A4");
	});

	it("returns undefined for unknown role names", () => {
		expect(roleHex("unknown")).toBeUndefined();
		expect(roleHex("")).toBeUndefined();
	});
});

describe("markdown theme backgrounded", () => {
	beforeEach(() => {
		useThemeMode("truecolor");
	});

	afterEach(() => {
		useThemeMode("truecolor");
	});

	it("colors a role descriptor with a truecolor background escape", () => {
		const backgrounded = getMarkdownTheme().backgrounded;
		expect(backgrounded).toBeDefined();
		expect(backgrounded?.("warn me", { channel: "bg", kind: "role", value: "warn" })).toBe(
			"\x1b[48;2;255;184;108mwarn me\x1b[49m",
		);
	});

	it("colors a hex descriptor with the exact RGB values", () => {
		const backgrounded = getMarkdownTheme().backgrounded;
		expect(backgrounded?.("hex", { channel: "bg", kind: "hex", value: "00FF00" })).toBe(
			"\x1b[48;2;0;255;0mhex\x1b[49m",
		);
	});

	it("leaves text unchanged for unknown roles", () => {
		const backgrounded = getMarkdownTheme().backgrounded;
		expect(backgrounded?.("plain", { channel: "bg", kind: "role", value: "missing" })).toBe("plain");
	});

	it("renders a hex descriptor in 256color mode with the nearest cube index", () => {
		useThemeMode("256color");
		const index = rgbTo256({ r: 255, g: 85, b: 85 });
		const colored = getMarkdownTheme().colored;
		expect(colored?.("red", { channel: "fg", kind: "hex", value: "FF5555" })).toBe(`\x1b[38;5;${index}mred\x1b[39m`);
	});

	it("renders 256color escapes when the theme is in 256color mode", () => {
		useThemeMode("256color");
		const index = rgbTo256({ r: 255, g: 184, b: 108 });
		const backgrounded = getMarkdownTheme().backgrounded;
		expect(backgrounded?.("warn me", { channel: "bg", kind: "role", value: "warn" })).toBe(
			`\x1b[48;5;${index}mwarn me\x1b[49m`,
		);
	});
});

describe("markdown theme colored", () => {
	beforeEach(() => {
		useThemeMode("truecolor");
	});

	afterEach(() => {
		useThemeMode("truecolor");
	});

	it("colors a role descriptor with a truecolor foreground escape", () => {
		const colored = getMarkdownTheme().colored;
		expect(colored).toBeDefined();
		expect(colored?.("warn me", { channel: "fg", kind: "role", value: "warn" })).toBe(
			"\x1b[38;2;255;184;108mwarn me\x1b[39m",
		);
	});

	it("colors a hex descriptor with the exact RGB values", () => {
		const colored = getMarkdownTheme().colored;
		expect(colored?.("hex", { channel: "fg", kind: "hex", value: "00FF00" })).toBe("\x1b[38;2;0;255;0mhex\x1b[39m");
	});

	it("leaves text unchanged for unknown roles", () => {
		const colored = getMarkdownTheme().colored;
		expect(colored?.("plain", { channel: "fg", kind: "role", value: "missing" })).toBe("plain");
	});

	it("renders 256color escapes when the theme is in 256color mode", () => {
		useThemeMode("256color");
		const index = rgbTo256({ r: 255, g: 184, b: 108 });
		const colored = getMarkdownTheme().colored;
		expect(colored?.("warn me", { channel: "fg", kind: "role", value: "warn" })).toBe(
			`\x1b[38;5;${index}mwarn me\x1b[39m`,
		);
	});

	it("composes with bold without dropping either SGR sequence", () => {
		const md = getMarkdownTheme();
		const inner = md.colored?.("both", { channel: "fg", kind: "role", value: "ok" }) ?? "both";
		const composed = md.bold(inner);
		expect(composed).toContain("\x1b[38;2;80;250;123m");
		expect(composed).toContain("\x1b[1m");
	});
});
