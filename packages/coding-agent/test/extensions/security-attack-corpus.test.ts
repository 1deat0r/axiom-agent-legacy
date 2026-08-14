/**
 * S-class threat corpus — DNS-aware SSRF gate (ADR-0028, ADR-0057).
 *
 * Permanent attack cases taken from the adversarial red-team review of the
 * merged dns-ssrf gate (/tmp/axiom-worktrees/dns-ssrf-redteam.md, 2026-08-14).
 * Per docs/agents/review-rubric.md §3, red-team findings become permanent
 * tests: every attack the red-team ran that the gate must keep blocking (or
 * keep allowing, for the documented exposure) is asserted here.
 *
 * The two classifier bugs the red-team found (the ::ffff:0: prefix misparse
 * and the IPv4-compatible ::/96 hole) have cases that FAILED on the pre-fix
 * code — see the fix report for the red evidence.
 *
 * Offline by construction: every DNS-aware case injects its own resolver via
 * the ADR-0057 seam; no case reaches the network.
 */
import { describe, expect, it, vi } from "vitest";
import {
	checkUrlSafety,
	type HostnameResolver,
	isPrivateIPv6,
	makeDefaultResolver,
} from "../../src/extensions/security/url.js";

// The default resolver's node:dns lookup is mocked for the whole file so the
// file is offline even if a case forgets to inject a resolver.
vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(async (_hostname: string, _opts: unknown) => [{ address: "8.8.8.8", family: 4 }]),
}));

function privateResolver(address = "10.0.0.5", family: 4 | 6 = 4): HostnameResolver {
	return async () => [{ address, family }];
}
function emptyResolver(): HostnameResolver {
	return async () => [];
}
function throwingResolver(): HostnameResolver {
	return async () => {
		throw new Error("resolver should not have been called");
	};
}
/** Mirrors getaddrinfo for the nip.io rebinding trick: the name resolves to 127.0.0.1. */
function loopbackDnsResolver(): HostnameResolver {
	return async () => [{ address: "127.0.0.1", family: 4 }];
}

describe("attack corpus — IPv6 literal edge cases (red-team §2)", () => {
	it("blocks the ::ffff:0: prefixed v4-mapped form (decodeHexV4 three-group fix)", async () => {
		// Red-team §2: '::ffff:0:127.0.0.1' is rewritten by the WHATWG URL
		// parser to '::ffff:0:7f00:1' before the gate sees it. Pre-fix,
		// decodeHexV4 misparsed the three-group tail ("0:7f00:1" -> "0.0.1")
		// and the gate ALLOWED it. Post-fix it must BLOCK.
		const d = await checkUrlSafety("http://[::ffff:0:127.0.0.1]/", { resolver: throwingResolver() });
		expect(d?.block).toBe(true);
	});
	it("blocks the IPv4-compatible ::/96 loopback form (defense in depth)", async () => {
		// Red-team §2: '::127.0.0.1' becomes '::7f00:1' after WHATWG parsing.
		// Pre-fix the classifier had no ::/96 rule and ALLOWED it. Some BSD and
		// Windows stacks translate ::/96 to the embedded IPv4; Linux here does
		// not (connect times out). Block anyway for defense in depth.
		const d = await checkUrlSafety("http://[::127.0.0.1]/", { resolver: throwingResolver() });
		expect(d?.block).toBe(true);
	});
	it("blocks v4-mapped dotted and hextet forms (regression, keep-safe)", async () => {
		for (const u of [
			"http://[::ffff:127.0.0.1]/", // dotted -> URL parser: ::ffff:7f00:1
			"http://[::ffff:7f00:1]/", // pure hextet
			"http://[0:0:0:0:0:ffff:7f00:1]/", // fully expanded
			"http://[::FFFF:7F00:1]/", // uppercase
		]) {
			const d = await checkUrlSafety(u, { resolver: throwingResolver() });
			expect(d?.block, u).toBe(true);
		}
	});
	it("keeps public v4-mapped and public global addresses allowed", async () => {
		// ::ffff:8.8.8.8 embeds a PUBLIC IPv4; ::ffff:0:0808:0808 is the same
		// payload under the ::ffff:0: prefix. Both must stay allowed.
		for (const u of ["http://[::ffff:8.8.8.8]/", "http://[::ffff:0:8.8.8.8]/"]) {
			expect(await checkUrlSafety(u, { resolver: throwingResolver() }), u).toBeUndefined();
		}
		expect(await checkUrlSafety("https://[2606:4700:4700::1111]/", { resolver: throwingResolver() })).toBeUndefined();
	});
});

describe("attack corpus — weird IPv4 literals (red-team §3)", () => {
	// Every form below is accepted by getaddrinfo as 127.0.0.1; the WHATWG URL
	// parser canonicalizes each to 127.0.0.1 before the gate runs, so the
	// literal stage must block WITHOUT a resolver call.
	it("blocks decimal, hex, octal, and trailing-dot loopback spellings", async () => {
		const spy = vi.fn(throwingResolver());
		for (const u of [
			"http://2130706433/", // decimal
			"http://0x7f000001/", // hex
			"http://0177.0.0.1/", // octal
			"http://127.0.0.1./", // trailing dot (URL parser strips it)
			"http://127.1/", // dotted shorthand
		]) {
			const d = await checkUrlSafety(u, { resolver: spy });
			expect(d?.block, u).toBe(true);
		}
		expect(spy).not.toHaveBeenCalled();
	});
	it("blocks the nip.io loopback rebinding hostname via DNS", async () => {
		// Red-team §3 headline: 127.0.0.1.nip.io resolves to 127.0.0.1. The
		// name is not loopback-patterned, so the DNS stage must catch it.
		const d = await checkUrlSafety("http://127.0.0.1.nip.io/", { resolver: loopbackDnsResolver() });
		expect(d?.block).toBe(true);
		expect(d!.reason).toContain("127.0.0.1");
	});
});

describe("attack corpus — resolver trust (red-team §4)", () => {
	it("blocks when any resolved address is private even among public ones", async () => {
		for (const answers of [
			[
				{ address: "8.8.8.8", family: 4 as const },
				{ address: "10.0.0.5", family: 4 as const },
			],
			[
				{ address: "8.8.8.8", family: 4 as const },
				{ address: "::1", family: 6 as const },
			],
		]) {
			const d = await checkUrlSafety("https://dual.example/x", { resolver: async () => answers });
			expect(d?.block).toBe(true);
		}
	});
	it("fails closed when the resolver returns no addresses", async () => {
		const d = await checkUrlSafety("https://empty.example/", { resolver: emptyResolver() });
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/no addresses/i);
	});
	it("fails closed on resolver rejection and unclassifiable families", async () => {
		const rejecting = await checkUrlSafety("https://gone.example/", {
			resolver: async () => {
				const err = new Error("EAI_AGAIN: name resolution failed") as NodeJS.ErrnoException;
				err.code = "EAI_AGAIN";
				throw err;
			},
		});
		expect(rejecting?.block).toBe(true);
		const family0 = makeDefaultResolver(1000, async () => [{ address: "1.2.3.4", family: 0 }]);
		const d = await checkUrlSafety("https://odd.example/", { resolver: family0 });
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/resolution failed/i);
	});
	it("fails closed when the lookup hangs (timeout race)", async () => {
		const resolve = makeDefaultResolver(5, () => new Promise<never>(() => {}));
		const d = await checkUrlSafety("https://slow.example/", { resolver: resolve });
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/timed out/i);
	});
});

describe("attack corpus — allowlist exact-match (red-team §5)", () => {
	it("does NOT allow subdomains or lookalikes of an allowlisted host", async () => {
		// Exact match only: sub.example.com is a different host, so DNS still
		// runs and the private answer blocks it.
		for (const u of ["http://sub.example.com/", "http://example.com.evil/", "http://evil.example.com.attacker.io/"]) {
			const d = await checkUrlSafety(u, { allowHosts: ["example.com"], resolver: privateResolver("127.0.0.1") });
			expect(d?.block, u).toBe(true);
		}
	});
	it("allowlists the exact host and skips DNS entirely", async () => {
		expect(
			await checkUrlSafety("http://example.com/", { allowHosts: ["example.com"], resolver: throwingResolver() }),
		).toBeUndefined();
	});
});

describe("attack corpus — pure classifier forms (red-team §2)", () => {
	it("classifies the fixed forms as private and the public controls as public", () => {
		// The two fixed bugs, at the pure classifier level.
		expect(isPrivateIPv6("::ffff:0:7f00:1")).toBe(true); // ::ffff:0: prefix + embedded loopback
		expect(isPrivateIPv6("::7f00:1")).toBe(true); // IPv4-compatible ::/96, embedded loopback
		expect(isPrivateIPv6("::ffff:0:0808:0808")).toBe(false); // same prefix, PUBLIC payload
		expect(isPrivateIPv6("::ffff:8.8.8.8")).toBe(false); // public v4-mapped stays allowed
		expect(isPrivateIPv6("::ffff:127.0.0.1")).toBe(true); // dotted mapped form
	});
	it("keeps the known over-block for mid-address ffff: (safe direction)", () => {
		// Red-team cosmetic note: the "ffff:" fallback over-blocks some public
		// addresses. Preserved: false positives in the safe direction.
		expect(isPrivateIPv6("2001:ffff:7f00:1::")).toBe(true);
	});
});

describe("DNS rebinding TOCTOU (documented exposure — issue #43, ADR-0066)", () => {
	// DOCUMENTED EXPOSURE, not a gate failure: the gate resolves the hostname
	// once and the fetch layer resolves it again; nothing pins the first
	// answer to the second (ADR-0057: "resolution here is point-in-time").
	// This test asserts the CURRENT behavior. When #43 ships (pin the checked
	// address into the fetch, or re-resolve and re-check at connect time),
	// UPDATE THIS TEST: the decision must become a BLOCK for the case below.
	it("resolves once and allows when the single answer is public (exposure #43)", async () => {
		const calls: string[] = [];
		const flappingResolver: HostnameResolver = async (hostname) => {
			calls.push(hostname);
			// First answer public, second answer private: the rebind.
			return calls.length === 1 ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
		};
		const decision = await checkUrlSafety("http://mustbearn:9981/steal", { resolver: flappingResolver });
		// Current behavior: one resolution, public answer, ALLOW.
		expect(decision).toBeUndefined();
		// The gate never asked twice; a second ask would have returned 127.0.0.1.
		expect(calls).toEqual(["mustbearn"]);
	});
});
