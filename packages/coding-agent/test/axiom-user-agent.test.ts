import { describe, expect, it } from "vitest";
import { getAxiomUserAgent } from "../src/utils/axiom-user-agent.js";

describe("getAxiomUserAgent", () => {
	it("formats the Axiom user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getAxiomUserAgent("1.2.3");

		expect(userAgent).toBe(`axiom/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^axiom\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
