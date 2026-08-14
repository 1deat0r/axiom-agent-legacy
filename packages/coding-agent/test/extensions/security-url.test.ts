import { describe, expect, it, vi } from "vitest";
import {
	checkUrlSafety,
	type HostnameResolver,
	isPrivateIPv4,
	isPrivateIPv6,
	makeDefaultResolver,
} from "../../src/extensions/security/url.js";

// The default resolver's node:dns lookup is mocked for the whole file so every
// test stays offline; each DNS-aware gate test injects its own resolver.
vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(async (_hostname: string, _opts: unknown) => [{ address: "8.8.8.8", family: 4 }]),
}));

/** Stub resolvers keep the DNS-aware gate tests offline (ADR-0057 seam). */
function publicResolver(): HostnameResolver {
	return async (_hostname) => [
		{ address: "8.8.8.8", family: 4 },
		{ address: "2606:4700:4700::1111", family: 6 },
	];
}
function privateResolver(address = "10.0.0.5", family: 4 | 6 = 4): HostnameResolver {
	return async (_hostname) => [{ address, family }];
}
function rejectingResolver(code: string): HostnameResolver {
	return async (_hostname) => {
		const err = new Error(`${code}: name resolution failed`) as NodeJS.ErrnoException;
		err.code = code;
		throw err;
	};
}
function emptyResolver(): HostnameResolver {
	return async (_hostname) => [];
}
function throwingResolver(): HostnameResolver {
	return async (_hostname) => {
		throw new Error("resolver should not have been called");
	};
}

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
	it("allows public IP literals without DNS", async () => {
		expect(await checkUrlSafety("https://8.8.8.8/dns")).toBeUndefined();
		expect(await checkUrlSafety("https://[2606:4700:4700::1111]/")).toBeUndefined();
	});
	it("allows named http(s) hosts that resolve only to public addresses", async () => {
		expect(await checkUrlSafety("https://example.com/a", { resolver: publicResolver() })).toBeUndefined();
		expect(await checkUrlSafety("http://example.com:8080/a?q=1", { resolver: publicResolver() })).toBeUndefined();
	});
	it("blocks a malformed URL", async () => {
		const d = await checkUrlSafety("not a url");
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/malformed/i);
	});
	it("blocks non-http(s) schemes", async () => {
		for (const u of [
			"file:///etc/passwd",
			"file://etc/passwd",
			"javascript:alert(1)",
			"data:text/plain,x",
			"ftp://example.com/x",
			"gopher://example.com/",
		]) {
			const d = await checkUrlSafety(u);
			expect(d?.block, u).toBe(true);
			expect(d!.reason).toMatch(/scheme/i);
		}
	});
	it("blocks credentials embedded in the URL", async () => {
		const d = await checkUrlSafety("https://user:secret@example.com/");
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/credential/i);
	});
	it("blocks loopback/private/link-local host literals (SSRF)", async () => {
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
			const d = await checkUrlSafety(u);
			expect(d?.block, u).toBe(true);
			expect(d!.reason).toMatch(/SSRF|address|hostname/i);
		}
	});
	it("blocks loopback-patterned hostnames without DNS", async () => {
		for (const u of ["http://localhost/", "http://localhost:3000/", "http://foo.localhost/", "http://mybox.local/"]) {
			expect((await checkUrlSafety(u))?.block, u).toBe(true);
		}
	});
	it("respects an explicit host allowlist", async () => {
		expect(await checkUrlSafety("http://127.0.0.1:3000/", { allowHosts: ["127.0.0.1"] })).toBeUndefined();
		expect(await checkUrlSafety("http://[::1]:8080/", { allowHosts: ["::1"] })).toBeUndefined();
	});
	it("respects extra allowed schemes", async () => {
		expect(
			await checkUrlSafety("ftp://example.com/x", { allowedSchemes: ["ftp"], resolver: publicResolver() }),
		).toBeUndefined();
	});
});

describe("checkUrlSafety — DNS-aware SSRF (ADR-0057)", () => {
	it("blocks a named host that resolves to a private IPv4 address", async () => {
		const d = await checkUrlSafety("https://intranet.corp/admin", { resolver: privateResolver("10.1.2.3") });
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/SSRF|private/i);
		expect(d!.reason).toContain("10.1.2.3");
	});
	it("blocks named hosts resolving to loopback, link-local, and CGN ranges", async () => {
		for (const addr of ["127.0.0.1", "169.254.169.254", "100.64.0.1", "192.168.1.1", "172.16.0.1"]) {
			const d = await checkUrlSafety("https://target.example/x", { resolver: privateResolver(addr) });
			expect(d?.block, addr).toBe(true);
		}
	});
	it("blocks named hosts resolving to private IPv6 (loopback, link-local, ULA, v4-mapped)", async () => {
		for (const addr of ["::1", "fe80::1", "fd00::1", "fc00::1", "::ffff:192.168.1.1"]) {
			const d = await checkUrlSafety("https://target.example/x", { resolver: privateResolver(addr, 6) });
			expect(d?.block, addr).toBe(true);
		}
	});
	it("blocks when any resolved address is private even when others are public", async () => {
		const d = await checkUrlSafety("https://dual.example/x", {
			resolver: async () => [
				{ address: "8.8.8.8", family: 4 },
				{ address: "10.0.0.5", family: 4 },
			],
		});
		expect(d?.block).toBe(true);
	});
	it("allows a named host when every resolved address is public", async () => {
		expect(await checkUrlSafety("https://api.stripe.com/v1", { resolver: publicResolver() })).toBeUndefined();
	});
	it("fails closed on resolver rejection (NXDOMAIN, timeout, generic error)", async () => {
		for (const code of ["ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"]) {
			const d = await checkUrlSafety("https://gone.example/x", { resolver: rejectingResolver(code) });
			expect(d?.block, code).toBe(true);
			expect(d!.reason, code).toMatch(/resolution failed/i);
			expect(d!.reason).toContain(code);
		}
		const generic = await checkUrlSafety("https://x.example/", {
			resolver: async () => {
				throw new Error("boom");
			},
		});
		expect(generic?.block).toBe(true);
		expect(generic!.reason).toMatch(/resolution failed/i);
	});
	it("fails closed when the resolver returns no addresses", async () => {
		const d = await checkUrlSafety("https://empty.example/", { resolver: emptyResolver() });
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/no addresses/i);
	});
	it("does not call the resolver for IP literals", async () => {
		const spy = vi.fn(publicResolver());
		expect(await checkUrlSafety("https://8.8.8.8/", { resolver: spy })).toBeUndefined();
		const blocked = await checkUrlSafety("http://10.0.0.1/", { resolver: spy });
		expect(blocked?.block).toBe(true);
		expect(spy).not.toHaveBeenCalled();
	});
	it("does not call the resolver for loopback-patterned hostnames", async () => {
		const spy = vi.fn(publicResolver());
		const d = await checkUrlSafety("http://localhost:3000/", { resolver: spy });
		expect(d?.block).toBe(true);
		expect(spy).not.toHaveBeenCalled();
	});
	it("skips resolution entirely for allowlisted hosts (AXIOM_FENCE_ALLOW_HOSTS)", async () => {
		expect(
			await checkUrlSafety("http://intranet.corp/x", {
				allowHosts: ["intranet.corp"],
				resolver: throwingResolver(),
			}),
		).toBeUndefined();
	});
	it("resolves only http(s) hosts; extra allowed schemes keep the literal checks", async () => {
		expect(
			await checkUrlSafety("ftp://example.com/x", { allowedSchemes: ["ftp"], resolver: throwingResolver() }),
		).toBeUndefined();
		const d = await checkUrlSafety("ftp://10.0.0.5/x", { allowedSchemes: ["ftp"], resolver: throwingResolver() });
		expect(d?.block).toBe(true);
	});
});

describe("makeDefaultResolver (node:dns seam)", () => {
	it("passes through A and AAAA records from the injected lookup", async () => {
		const resolve = makeDefaultResolver(1000, async () => [
			{ address: "8.8.8.8", family: 4 },
			{ address: "2606:4700:4700::1111", family: 6 },
		]);
		await expect(resolve("example.com")).resolves.toEqual([
			{ address: "8.8.8.8", family: 4 },
			{ address: "2606:4700:4700::1111", family: 6 },
		]);
	});
	it("propagates a lookup rejection", async () => {
		const resolve = makeDefaultResolver(1000, async () => {
			const err = new Error("ENOTFOUND getaddrinfo") as NodeJS.ErrnoException;
			err.code = "ENOTFOUND";
			throw err;
		});
		await expect(resolve("gone.example")).rejects.toThrow(/ENOTFOUND/);
	});
	it("rejects when the lookup returns an unclassifiable family", async () => {
		const resolve = makeDefaultResolver(1000, async () => [{ address: "1.2.3.4", family: 0 }]);
		await expect(resolve("odd.example")).rejects.toThrow(/family/i);
	});
	it("times out when the lookup never settles", async () => {
		const resolve = makeDefaultResolver(5, () => new Promise<never>(() => {}));
		await expect(resolve("slow.example")).rejects.toThrow(/timed out/i);
	});
	it("uses node:dns lookup with all records by default", async () => {
		const { lookup } = await import("node:dns/promises");
		const resolve = makeDefaultResolver(1000);
		await expect(resolve("example.com")).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
		expect(lookup).toHaveBeenCalledWith("example.com", { all: true });
	});
});
