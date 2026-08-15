import { describe, expect, it } from "vitest";
import { translateWatchKey } from "../../src/extensions/delegate/watch-tui.js";

describe("translateWatchKey", () => {
	it("maps q and Ctrl-C to quit", () => {
		expect(translateWatchKey("q")).toBe("quit");
		expect(translateWatchKey("\u0003")).toBe("quit");
	});

	it("maps up arrow and k to scrollUp (scroll back)", () => {
		expect(translateWatchKey("\u001b[A")).toBe("scrollUp");
		expect(translateWatchKey("k")).toBe("scrollUp");
	});

	it("maps down arrow and j to scrollDown (scroll forward)", () => {
		expect(translateWatchKey("\u001b[B")).toBe("scrollDown");
		expect(translateWatchKey("j")).toBe("scrollDown");
	});

	it("maps g to jumpTop and G to jumpBottom", () => {
		expect(translateWatchKey("g")).toBe("jumpTop");
		expect(translateWatchKey("G")).toBe("jumpBottom");
	});

	it("ignores any other input", () => {
		expect(translateWatchKey("x")).toBeNull();
		expect(translateWatchKey("\u001b")).toBeNull();
		expect(translateWatchKey("")).toBeNull();
	});
});
