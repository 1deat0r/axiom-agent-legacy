import { describe, expect, it } from "vitest";
import { checkSensitiveTool, extractUrlField } from "../../src/extensions/security/fence.js";
import type { HostnameResolver } from "../../src/extensions/security/url.js";

/** Stub resolvers keep the DNS-aware URL gate tests offline (ADR-0057). */
function publicResolver(): HostnameResolver {
	return async (_hostname) => [{ address: "8.8.8.8", family: 4 }];
}
function privateResolver(): HostnameResolver {
	return async (_hostname) => [{ address: "10.0.0.5", family: 4 }];
}

describe("extractUrlField", () => {
	it("returns a non-empty string url field", () => {
		expect(extractUrlField({ url: "https://example.com/x" })).toBe("https://example.com/x");
	});
	it("returns undefined for missing, empty, or non-string url", () => {
		expect(extractUrlField({ path: "/x" })).toBeUndefined();
		expect(extractUrlField({ url: "" })).toBeUndefined();
		expect(extractUrlField({ url: 42 })).toBeUndefined();
		expect(extractUrlField(null)).toBeUndefined();
		expect(extractUrlField("nope")).toBeUndefined();
	});
});

describe("checkSensitiveTool — URL gate on URL-bearing tools", () => {
	it("runs the URL-safety gate on any url-bearing tool (egress fence)", async () => {
		const d = await checkSensitiveTool("fetch", { url: "http://169.254.169.254/latest/meta-data" });
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/SSRF|address/i);
	});
	it("allows a safe URL with no sensitive rule", async () => {
		expect(
			await checkSensitiveTool("fetch", { url: "https://example.com/x" }, { resolver: publicResolver() }),
		).toBeUndefined();
	});
	it("does not gate a tool that carries no url field", async () => {
		expect(await checkSensitiveTool("edit", { path: "/a.ts" })).toBeUndefined();
	});
	it("blocks a URL-bearing tool whose named host resolves private (DNS flows through the fence)", async () => {
		const d = await checkSensitiveTool(
			"fetch",
			{ url: "https://intranet.corp/admin" },
			{ resolver: privateResolver() },
		);
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/SSRF|private/i);
	});
});

describe("checkSensitiveTool — approved-tool fence", () => {
	it("blocks a sensitive tool unless it is approved", async () => {
		const d = await checkSensitiveTool("ext_egress", {}, { sensitiveTools: ["ext_egress"] });
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/approved-tool fence/i);
	});
	it("allows a sensitive tool once approved", async () => {
		expect(
			await checkSensitiveTool("ext_egress", {}, { sensitiveTools: ["ext_egress"], approvedTools: ["ext_egress"] }),
		).toBeUndefined();
	});
	it("defaults sensitive list to empty (opt-in) so ordinary tools pass untouched", async () => {
		expect(await checkSensitiveTool("edit", { path: "/a.ts" }, {})).toBeUndefined();
		expect(await checkSensitiveTool("bash", { command: "ls" }, {})).toBeUndefined(); // freeform stance, ADR-0018
	});
	it("does not treat approved-only names as capabilities", async () => {
		// approving an unrelated tool does not override a sensitive block for another
		const d = await checkSensitiveTool("a", {}, { sensitiveTools: ["a", "b"], approvedTools: ["b"] });
		expect(d?.block).toBe(true);
	});
});
