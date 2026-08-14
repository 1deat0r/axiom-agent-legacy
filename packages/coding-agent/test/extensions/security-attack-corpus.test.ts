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
 * code — see the fix report for the red evidence. The DNS rebinding cases
 * (ADR-0066, issue #43) extend the corpus with the flip attacks from the
 * live repro and the pinned-fetch fake-socket cases.
 *
 * Offline by construction: every DNS-aware case injects its own resolver via
 * the ADR-0057 seam; no case reaches the network.
 */

import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
	buildPinnedRequestOptions,
	fetchPinned,
	type PinnedFetcher,
} from "../../src/extensions/security/fetch-pinned.js";
import {
	checkUrlSafety,
	checkUrlSafetyPinned,
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

describe("DNS rebinding pinning — the checked address is the connect address (ADR-0066, issue #43)", () => {
	// The red-team live repro (/tmp/ssrf-redteam/rebinding.mts, 2026-08-14):
	// the gate resolved once (attacker answer: public), the fetch resolved
	// again (system answer: 127.0.1.1) and read a loopback secret. ADR-0066
	// closes the window two ways: the gate re-resolves at connect time and
	// re-checks, and the gate-owned fetchPinned connects to the CHECKED
	// addresses (never resolving on its own).
	it("blocks the rebind flip: public for the check, loopback at connect time", async () => {
		const calls: string[] = [];
		const flappingResolver: HostnameResolver = async (hostname) => {
			calls.push(hostname);
			return calls.length === 1 ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
		};
		const d = await checkUrlSafety("http://mustbearn:9981/steal", { resolver: flappingResolver });
		expect(d?.block).toBe(true);
		expect(d!.reason).toContain("127.0.0.1");
		expect(d!.reason).toMatch(/rebind/i);
		expect(calls).toEqual(["mustbearn", "mustbearn"]);
	});
	it("blocks an IPv6 rebind flip (public v6 for the check, ::1 at connect time)", async () => {
		let n = 0;
		const d = await checkUrlSafety("https://v6.example/", {
			resolver: async () =>
				n++ === 0 ? [{ address: "2606:4700:4700::1111", family: 6 }] : [{ address: "::1", family: 6 }],
		});
		expect(d?.block).toBe(true);
		expect(d!.reason).toContain("::1");
	});
	it("blocks mixed answers when the connect-time set gains a private address", async () => {
		let n = 0;
		const d = await checkUrlSafety("https://dual.example/", {
			resolver: async () =>
				n++ === 0
					? [
							{ address: "8.8.8.8", family: 4 },
							{ address: "2606:4700:4700::1111", family: 6 },
						]
					: [
							{ address: "8.8.8.8", family: 4 },
							{ address: "fd00::1", family: 6 },
						],
		});
		expect(d?.block).toBe(true);
		expect(d!.reason).toContain("fd00::1");
	});
	it("fails closed when the connect-time re-resolution rejects or returns nothing", async () => {
		let n = 0;
		const rejecting: HostnameResolver = async () => {
			n++;
			if (n === 1) return [{ address: "8.8.8.8", family: 4 }];
			const err = new Error("ENOTFOUND: name resolution failed") as NodeJS.ErrnoException;
			err.code = "ENOTFOUND";
			throw err;
		};
		const d = await checkUrlSafety("https://gone.example/", { resolver: rejecting });
		expect(d?.block).toBe(true);
		expect(d!.reason).toMatch(/connect-time re-resolution/i);

		let m = 0;
		const emptying: HostnameResolver = async () => (m++ === 0 ? [{ address: "8.8.8.8", family: 4 }] : []);
		const e = await checkUrlSafety("https://empty.example/", { resolver: emptying });
		expect(e?.block).toBe(true);
		expect(e!.reason).toMatch(/no addresses/i);
	});
	it("keeps legitimate multi-IP hosts allowed and pins the connect-time answer (keep-safe)", async () => {
		const stable: HostnameResolver = async () => [
			{ address: "1.1.1.1", family: 4 },
			{ address: "1.0.0.1", family: 4 },
		];
		const verdict = await checkUrlSafetyPinned("https://multi.example/", { resolver: stable });
		expect(verdict.block).toBe(false);
		if (verdict.block) throw new Error("expected allow");
		expect(verdict.pin?.hostname).toBe("multi.example");
		expect(verdict.pin?.addresses).toEqual([
			{ address: "1.1.1.1", family: 4 },
			{ address: "1.0.0.1", family: 4 },
		]);
		// round-robin hosts that reorder or grow their public pool still allow.
		let n = 0;
		const rotating: HostnameResolver = async () =>
			n++ === 0
				? [{ address: "1.1.1.1", family: 4 }]
				: [
						{ address: "1.0.0.1", family: 4 },
						{ address: "1.1.1.1", family: 4 },
					];
		const rotated = await checkUrlSafetyPinned("https://rr.example/", { resolver: rotating });
		expect(rotated.block).toBe(false);
		if (rotated.block) throw new Error("expected allow");
		expect(rotated.pin?.addresses.length).toBe(2);
	});
});

describe("pinned fetch — the fetch connects to the checked address, never a fresh answer (ADR-0066)", () => {
	it("connects to the pin even when a fresh resolution would answer loopback (fake socket)", async () => {
		// The live repro shape: the gate's two resolutions answer public; a
		// THIRD resolution (the fetch's own) would answer 127.0.0.1. The
		// pinned fetch must never make that third resolution.
		let calls = 0;
		const resolver: HostnameResolver = async () => {
			calls++;
			return calls <= 2 ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
		};
		let loopbackReached = false;
		const connectedTo: string[] = [];
		const fetcher: PinnedFetcher = async (_url, pin) => {
			const addr = pin?.addresses[0]?.address ?? "unresolved";
			connectedTo.push(addr);
			if (addr.startsWith("127.")) loopbackReached = true;
			throw new Error(`ECONNREFUSED ${addr}`); // public pin is unreachable in this fake sandbox
		};
		await expect(fetchPinned("http://mustbearn:9981/steal", { resolver, fetcher })).rejects.toThrow(
			/ECONNREFUSED 8\.8\.8\.8/,
		);
		expect(connectedTo).toEqual(["8.8.8.8"]);
		expect(loopbackReached).toBe(false);
		expect(calls).toBe(2); // gate resolved twice; the FETCH resolved zero times
	});
	it("re-gates every redirect hop and blocks a redirect to loopback (fake socket)", async () => {
		const resolver: HostnameResolver = async () => [{ address: "8.8.8.8", family: 4 }];
		const fetched: string[] = [];
		const fetcher: PinnedFetcher = async (url, _pin) => {
			fetched.push(url.toString());
			if (url.hostname === "public.example") {
				return new Response("moved", { status: 302, headers: { location: "http://127.0.0.1/secret" } });
			}
			return new Response("INTERNAL-SECRET", { status: 200 });
		};
		await expect(fetchPinned("http://public.example/", { resolver, fetcher })).rejects.toThrow(/127\.0\.0\.1/);
		expect(fetched).toEqual(["http://public.example/"]); // the private redirect target was never fetched
	});
	it("preserves the original port and Host on a pinned connect (non-HTTP port rebind)", async () => {
		const options = buildPinnedRequestOptions(new URL("http://mustbearn:9981/steal"), {
			hostname: "mustbearn",
			addresses: [{ address: "8.8.8.8", family: 4 }],
		});
		expect(options.hostname).toBe("mustbearn");
		expect(options.port).toBe(9981);
		expect(options.method).toBe("GET");
		expect(options.headers).toBeDefined();
		const lookup = options.lookup as LookupFunction;
		const results = await new Promise<LookupAddress[]>((resolve, reject) => {
			lookup("mustbearn", {}, (err, addrs) => (err ? reject(err) : resolve(addrs as LookupAddress[])));
		});
		expect(results).toEqual([{ address: "8.8.8.8", family: 4 }]);
	});
	it("keeps TLS hostname verification on the original hostname (https pin)", async () => {
		const options = buildPinnedRequestOptions(new URL("https://tls.example/"), {
			hostname: "tls.example",
			addresses: [{ address: "8.8.8.8", family: 4 }],
		});
		expect(options.servername ?? options.hostname).toBe("tls.example");
		expect(options.rejectUnauthorized).toBeUndefined(); // never disabled: node's default verification stays on
	});
});
