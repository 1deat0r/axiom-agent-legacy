import { describe, expect, it } from "vitest";
import { checkSensitiveTool, extractUrlField } from "../../src/extensions/security/fence.js";

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
	it("runs the URL-safety gate on any url-bearing tool (egress fence)", () => {
		const d = checkSensitiveTool("fetch", { url: "http://169.254.169.254/latest/meta-data" });
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/SSRF|address/i);
	});
	it("allows a safe URL with no sensitive rule", () => {
		expect(checkSensitiveTool("fetch", { url: "https://example.com/x" })).toBeUndefined();
	});
	it("does not gate a tool that carries no url field", () => {
		expect(checkSensitiveTool("edit", { path: "/a.ts" })).toBeUndefined();
	});
});

describe("checkSensitiveTool — approved-tool fence", () => {
	it("blocks a sensitive tool unless it is approved", () => {
		const d = checkSensitiveTool("ext_egress", {}, { sensitiveTools: ["ext_egress"] });
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/approved-tool fence/i);
	});
	it("allows a sensitive tool once approved", () => {
		expect(
			checkSensitiveTool("ext_egress", {}, { sensitiveTools: ["ext_egress"], approvedTools: ["ext_egress"] }),
		).toBeUndefined();
	});
	it("defaults sensitive list to empty (opt-in) so ordinary tools pass untouched", () => {
		expect(checkSensitiveTool("edit", { path: "/a.ts" }, {})).toBeUndefined();
		expect(checkSensitiveTool("bash", { command: "ls" }, {})).toBeUndefined(); // freeform stance, ADR-0018
	});
	it("does not treat approved-only names as capabilities", () => {
		// approving an unrelated tool does not override a sensitive block for another
		const d = checkSensitiveTool("a", {}, { sensitiveTools: ["a", "b"], approvedTools: ["b"] });
		expect(d?.block).toBe(true);
	});
});
