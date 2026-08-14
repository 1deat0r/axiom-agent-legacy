import assert from "node:assert";
import { describe, it } from "node:test";
import { parseColorDescriptor, parseHexLiteral } from "../src/color-descriptor.js";

describe("parseColorDescriptor", () => {
	it("parses a role foreground descriptor", () => {
		assert.deepEqual(parseColorDescriptor("#role:warn"), { channel: "fg", kind: "role", value: "warn" });
	});

	it("parses a role background descriptor", () => {
		assert.deepEqual(parseColorDescriptor("#bg:ok"), { channel: "bg", kind: "role", value: "ok" });
	});

	it("parses a hex foreground descriptor", () => {
		assert.deepEqual(parseColorDescriptor("#hex:ff5555"), { channel: "fg", kind: "hex", value: "FF5555" });
	});

	it("parses a hex background descriptor", () => {
		assert.deepEqual(parseColorDescriptor("#hexbg:A1B2C3"), { channel: "bg", kind: "hex", value: "A1B2C3" });
	});

	it("rejects an unknown role name", () => {
		assert.equal(parseColorDescriptor("#role:unknown"), undefined);
	});

	it("rejects an uppercase role name", () => {
		assert.equal(parseColorDescriptor("#role:WARN"), undefined);
	});

	it("rejects a five digit hex value", () => {
		assert.equal(parseColorDescriptor("#hex:12345"), undefined);
	});

	it("rejects non-hex digits in a hex value", () => {
		assert.equal(parseColorDescriptor("#hex:GGGGGG"), undefined);
	});

	it("rejects a plain fragment link", () => {
		assert.equal(parseColorDescriptor("#section"), undefined);
	});

	it("rejects a plain url", () => {
		assert.equal(parseColorDescriptor("https://example.com"), undefined);
	});
});

describe("parseHexLiteral", () => {
	it("parses a standalone six digit hex literal", () => {
		assert.equal(parseHexLiteral("#FF5555"), "FF5555");
	});

	it("parses a lowercase six digit hex literal", () => {
		assert.equal(parseHexLiteral("#50fa7b"), "50FA7B");
	});

	it("rejects a five digit literal", () => {
		assert.equal(parseHexLiteral("#FF555"), undefined);
	});

	it("rejects text with embedded hex", () => {
		assert.equal(parseHexLiteral("text#FF5555"), undefined);
	});

	it("rejects a three digit shorthand", () => {
		assert.equal(parseHexLiteral("#F55"), undefined);
	});
});
