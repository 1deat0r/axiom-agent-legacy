import { describe, expect, it } from "vitest";
import { checkUrlSafety, isPrivateIPv4, isPrivateIPv6 } from "../../src/extensions/security/url.js";

describe("isPrivateIPv4 (pure range classification)", () => {
	it("flags loopback, private, link-local, unspecified", () => {
		for (const ip of [
			"127.0.0.1",
			"10.0.0.5",
			"10.255.255.255",
			"172.16.0.1",
			"172.31.9.9",
			"192.168.1.42",
			"169.254.10.10",
			"0.0.0.0",
			"100.64.0.1",
		]) {
			expect(isPrivateIPv4(ip), ip).toBe(true);
		}
	});
	it("allows public ranges", () => {
		for (const ip of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.1.1", "1.1.1.1", "93.184.216.34"]) {
			expect(isPrivateIPv4(ip), ip).toBe(false);
		}
	});
});

describe("isPrivateIPv6 (pure classification)", () => {
	it("flags loopback, unspecified, link-local, ULA, v4-mapped", () => {
		for (const addr of [
			"::1",
			"::",
			"fe80::1",
			"fe80::1%eth0",
			"fd00::1",
			"fc00::1",
			"::ffff:127.0.0.1",
			"::ffff:192.168.1.1",
		]) {
			expect(isPrivateIPv6(addr), addr).toBe(true);
		}
	});
	it("allows public global unicast and public v4-mapped", () => {
		for (const addr of ["2606:4700:4700::1111", "::ffff:8.8.8.8", "2001:4860:4860::8888"]) {
			expect(isPrivateIPv6(addr), addr).toBe(false);
		}
	});
});

describe("checkUrlSafety (pure gate)", () => {
	it("allows ordinary https/http public URLs", () => {
		expect(checkUrlSafety("https://example.com/a")).toBeUndefined();
		expect(checkUrlSafety("http://example.com:8080/a?q=1")).toBeUndefined();
		expect(checkUrlSafety("https://8.8.8.8/dns")).toBeUndefined();
		expect(checkUrlSafety("https://[2606:4700:4700::1111]/")).toBeUndefined();
	});
	it("blocks a malformed URL", () => {
		const d = checkUrlSafety("not a url");
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/malformed/i);
	});
	it("blocks non-http(s) schemes", () => {
		for (const u of [
			"file:///etc/passwd",
			"file://etc/passwd",
			"javascript:alert(1)",
			"data:text/plain,x",
			"ftp://example.com/x",
			"gopher://example.com/",
		]) {
			const d = checkUrlSafety(u);
			expect(d?.block, u).toBe(true);
			expect(d!.reason).toMatch(/scheme/i);
		}
	});
	it("blocks credentials embedded in the URL", () => {
		const d = checkUrlSafety("https://user:secret@example.com/");
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/credential/i);
	});
	it("blocks loopback/private/link-local host literals (SSRF)", () => {
		for (const u of [
			"http://127.0.0.1/",
			"http://10.1.2.3/admin",
			"http://172.16.0.1/",
			"http://192.168.0.1/",
			"http://169.254.169.254/latest/meta-data",
			"http://[::1]/",
			"http://[fd00::1]/",
			"http://[fe80::1]/",
		]) {
			const d = checkUrlSafety(u);
			expect(d?.block, u).toBe(true);
			expect(d!.reason).toMatch(/SSRF|address|hostname/i);
		}
	});
	it("blocks loopback-patterned hostnames", () => {
		for (const u of ["http://localhost/", "http://localhost:3000/", "http://foo.localhost/", "http://mybox.local/"]) {
			expect(checkUrlSafety(u)?.block, u).toBe(true);
		}
	});
	it("allows arbitrary named hosts (DNS resolution is the documented follow-up)", () => {
		expect(checkUrlSafety("http://intranet.corp/x")).toBeUndefined();
		expect(checkUrlSafety("https://api.stripe.com/v1")).toBeUndefined();
	});
	it("respects an explicit host allowlist", () => {
		expect(checkUrlSafety("http://127.0.0.1:3000/", { allowHosts: ["127.0.0.1"] })).toBeUndefined();
		expect(checkUrlSafety("http://[::1]:8080/", { allowHosts: ["::1"] })).toBeUndefined();
	});
	it("respects extra allowed schemes", () => {
		expect(checkUrlSafety("ftp://example.com/x", { allowedSchemes: ["ftp"] })).toBeUndefined();
	});
});
