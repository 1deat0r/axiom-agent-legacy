/**
 * URL-safe fetch gate — URL safety with DNS-aware SSRF protection
 * (ADR-0028, ADR-0057; security fence).
 *
 * The egress half of the security fence: any tool call that carries a `url`
 * argument (a fetch channel) is poked through `checkUrlSafety` before it runs
 * on an anchored project. Rejects, with a plain-English reason surfaced to the
 * model:
 *  - malformed URLs,
 *  - non-http(s) schemes (file:, data:, javascript:, ftp:, gopher:, ...),
 *  - URLs embedding credentials (SSRF/credential-leak vector),
 *  - SSRF-prone host literals: loopback / private / link-local / ULA / v4-mapped /
 *    IPv4-compatible (::/96) IPv4+IPv6, and loopback-patterned hostnames
 *    (localhost, *.localhost, *.local),
 *  - named http(s) hosts whose resolved A/AAAA addresses are SSRF-prone
 *    (ADR-0057), and named http(s) hosts whose resolution FAILS — fail closed.
 *
 * DNS boundary (ADR-0057): resolution runs only for named hosts on http(s)
 * schemes that pass the literal checks; IP literals and loopback-patterned
 * hostnames are classified without DNS, and allowlisted hosts skip resolution.
 * Resolution is a pure injectable seam (`resolver`) so unit tests stay offline;
 * the default resolver uses node:dns lookup raced against a timeout.
 *
 * DNS rebinding (ADR-0066): a named http(s) host is resolved TWICE — the
 * check, then a connect-time re-resolution that is re-classified — and the
 * connect-time answer is pinned on the allow verdict. The gate-owned
 * `fetchPinned` connects to the pinned addresses with the original Host
 * header, so the checked address is the address the fetch reaches. Result
 * caching is still out of scope (recorded follow-up).
 */
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export interface UrlSafetyOptions {
	/** Extra schemes allowed beyond http/https (default: none). */
	allowedSchemes?: string[];
	/** Hosts (hostname or IP literal, brackets stripped) always allowed even if private/loopback. */
	allowHosts?: string[];
	/** Resolver seam for named http(s) hosts (ADR-0057). Default: node:dns lookup. */
	resolver?: HostnameResolver;
	/** Timeout (ms) for the default resolver. Ignored when `resolver` is injected. */
	dnsTimeoutMs?: number;
}

export type UrlSafeDecision = { block: true; reason: string } | undefined;

/** The verified connect-time resolution for a named http(s) host (ADR-0066). */
export interface PinnedResolution {
	/** The normalized hostname (brackets stripped). */
	hostname: string;
	/** The addresses the gate verified are public; fetchPinned connects to these. */
	addresses: ResolvedAddress[];
}

/** Full gate verdict: a block with a reason, or an allow with the pin (named hosts). */
export type UrlGateVerdict = { block: true; reason: string } | { block: false; pin?: PinnedResolution };

/** One resolved address: the address string plus its IP family. */
export interface ResolvedAddress {
	address: string;
	/** 4 (IPv4) or 6 (IPv6). */
	family: 4 | 6;
}

/**
 * Resolver seam (ADR-0057): resolves a hostname to its A/AAAA addresses.
 * Rejecting is a resolution failure (NXDOMAIN, timeout, resolver error) and the
 * gate fails closed. Returning an empty list also fails closed.
 */
export type HostnameResolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** Lookup seam for the default resolver (injectable in tests). */
export type LookupFn = (hostname: string) => Promise<LookupAddress[]>;

/** Default DNS timeout for the built-in resolver (ms). */
export const DEFAULT_DNS_TIMEOUT_MS = 2000;

function dnsTimeoutError(hostname: string, timeoutMs: number): Error {
	const err = new Error(`DNS lookup of '${hostname}' timed out after ${timeoutMs}ms`) as NodeJS.ErrnoException;
	err.code = "ETIMEDOUT";
	return err;
}

function unclassifiableFamilyError(hostname: string): Error {
	return new Error(`DNS lookup of '${hostname}' returned an unclassifiable address family`);
}

/**
 * Default resolver: node:dns `lookup` (getaddrinfo, A + AAAA records) raced
 * against a timeout so a hung resolver fails closed. Rejects on lookup error,
 * timeout, or an unclassifiable address family.
 */
export function makeDefaultResolver(
	timeoutMs: number = DEFAULT_DNS_TIMEOUT_MS,
	lookupFn: LookupFn = (hostname) => dnsLookup(hostname, { all: true }),
): HostnameResolver {
	return async (hostname) => {
		const result = await Promise.race([
			lookupFn(hostname),
			sleep(timeoutMs).then(() => {
				throw dnsTimeoutError(hostname, timeoutMs);
			}),
		]);
		return result.map((r) => {
			if (r.family !== 4 && r.family !== 6) throw unclassifiableFamilyError(hostname);
			return { address: r.address, family: r.family };
		});
	};
}

/** True iff `host` (lowercased, bracket-stripped) is explicitly allowlisted. */
function isAllowedHost(host: string, allowHosts?: string[]): boolean {
	if (!allowHosts || allowHosts.length === 0) return false;
	return allowHosts.some((h) => normalizeHost(h) === host);
}

export function normalizeHost(host: string): string {
	let h = host.toLowerCase();
	if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
	return h;
}

/** Classify a dotted-quad IPv4 against private/reserved ranges. */
export function isPrivateIPv4(ip: string): boolean {
	const parts = ip.split(".");
	if (parts.length !== 4) return false;
	const [a, b] = [Number(parts[0]), Number(parts[1])];
	if (![a, b, Number(parts[2]), Number(parts[3])].every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
		return false;
	switch (true) {
		case a === 0: // 0.0.0.0/8 "this network"
		case a === 10: // 10.0.0.0/8
		case a === 127: // 127.0.0.0/8 loopback
		case a === 169 && b === 254: // 169.254.0.0/16 link-local
		case a === 192 && b === 168: // 192.168.0.0/16
		case a === 100 && b >= 64 && b <= 127: // 100.64.0.0/10 shared (CGN)
		case a === 172 && b >= 16 && b <= 31: // 172.16.0.0/12
			return true;
		default:
			return false;
	}
}

/** Decode a trailing hex IPv4 tail ("c0a8:0101" -> 192.168.1.1) from a v4-mapped IPv6. */
function decodeHexV4(tail: string): string {
	const groups = tail
		.replace(/\./g, ":")
		.split(":")
		.filter(Boolean)
		.map((p) => Number.parseInt(p, 16));
	if (groups.length === 2) {
		// two 16-bit groups -> four octets
		return [(groups[0] >> 8) & 0xff, groups[0] & 0xff, (groups[1] >> 8) & 0xff, groups[1] & 0xff].join(".");
	}
	// otherwise take up to four leading octets from wide groups
	return groups
		.slice(0, 4)
		.map((g) => g & 0xff)
		.join(".");
}

/** Expand a compressed IPv6 literal into its eight hextets, or undefined when unparseable. */
function expandHextets(addr: string): number[] | undefined {
	const halves = addr.split("::");
	if (halves.length > 2) return undefined;
	const left = halves[0] === "" ? [] : halves[0].split(":");
	const right = halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
	if (halves.length === 1) {
		if (left.length !== 8) return undefined;
	} else if (8 - left.length - right.length < 1) {
		return undefined; // "::" must stand for at least one zero group
	}
	const groups =
		halves.length === 1 ? left : [...left, ...new Array<string>(8 - left.length - right.length).fill("0"), ...right];
	if (groups.length !== 8) return undefined;
	if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
	return groups.map((g) => Number.parseInt(g, 16));
}

/** Render two hextets as a dotted-quad IPv4 ("7f00", "0001" -> "127.0.0.1"). */
function hextetsToV4(hi: number, lo: number): string {
	return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
}

/** Extract a trailing dotted-quad from a v4-mapped IPv6 (e.g. "::ffff:192.168.1.1"). */
function extractDottedV4(addr: string): string | undefined {
	const m = /\d{1,3}(?:\.\d{1,3}){3}$/.exec(addr);
	return m?.[0];
}

/** Classify an IPv6 literal against private/reserved ranges. */
export function isPrivateIPv6(addr: string): boolean {
	const s = normalizeHost(addr).split("%")[0]; // strip zone id (fe80::1%eth0)
	// v4-mapped / v4-embedded with a dotted tail (::ffff:127.0.0.1)
	const dotted = extractDottedV4(s);
	if (dotted) return isPrivateIPv4(dotted);
	// exact hextet classification for the v4-embedded forms
	const hextets = expandHextets(s);
	if (hextets) {
		const firstFiveZero = hextets.slice(0, 5).every((h) => h === 0);
		// v4-mapped ::ffff:0:0/96 (0:0:0:0:0:ffff:x:y)
		if (firstFiveZero && hextets[5] === 0xffff) {
			return isPrivateIPv4(hextetsToV4(hextets[6], hextets[7]));
		}
		// ::ffff:0: prefix (0:0:0:0:ffff:0:x:y): the WHATWG URL parser rewrites
		// "::ffff:0:a.b.c.d" into this shape, so the last two hextets are the
		// embedded IPv4. The old decodeHexV4 misparsed this three-group tail as
		// "0.0.1" and the gate allowed the form (red-team finding).
		if (hextets.slice(0, 4).every((h) => h === 0) && hextets[4] === 0xffff && hextets[5] === 0) {
			return isPrivateIPv4(hextetsToV4(hextets[6], hextets[7]));
		}
		// IPv4-compatible ::/96 (0:0:0:0:0:0:x:y): deprecated and reserved.
		// BSD/Windows translate the tail to IPv4; classify the whole prefix as
		// private for defense in depth (red-team finding: Linux alone leaves
		// ::7f00:1 unreachable, other stacks reach the embedded loopback).
		if (hextets.slice(0, 6).every((h) => h === 0)) return true;
	}
	// v4-mapped in pure hextet form for spellings the expander rejects
	// (conservative fallback: over-blocks some public addresses, the safe
	// direction, kept per the red-team cosmetic note)
	const idx = s.indexOf("ffff:");
	if (idx !== -1 && s.indexOf(".", idx) === -1) {
		return isPrivateIPv4(decodeHexV4(s.slice(idx + 5)));
	}
	// fully-expanded loopback / unspecified forms
	if (s === "::" || s === "0:0:0:0:0:0:0:0") return true;
	if (s === "::1" || s === "0:0:0:0:0:0:0:1") return true;
	// link-local fe80::/10 (fe80..febf)
	if (/^fe[89ab]/.test(s)) return true;
	// unique-local fc00::/7
	if (/^f[cd][0-9a-f]/.test(s)) return true;
	return false;
}

/** Loopback-patterned hostnames that are unsafe without DNS. */
function isLoopbackHostname(host: string): boolean {
	if (host === "localhost" || host === "0") return true;
	return host.endsWith(".localhost") || host.endsWith(".local");
}

/** Render a resolver error for the block reason (code + message when known). */
function describeDnsError(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code ? `${code}: ${error.message}` : error.message;
	}
	return String(error);
}

/**
 * The two DNS phases for a named http(s) host (ADR-0057 check, ADR-0066
 * connect-time re-check). Returns the classified addresses, or a block
 * reason. The connect phase re-resolves the hostname and re-classifies, so a
 * resolver that flips answers between the gate check and the fetch is caught;
 * `fetchPinned` then connects to the verified connect-time addresses, so the
 * checked address is the connect address.
 */
type ResolutionPhase = "check" | "connect";

type ResolvedCheck = { ok: true; addresses: ResolvedAddress[] } | { ok: false; reason: string };

async function resolveAndClassify(
	rawUrl: string,
	host: string,
	resolver: HostnameResolver,
	phase: ResolutionPhase,
): Promise<ResolvedCheck> {
	let addresses: ResolvedAddress[];
	try {
		addresses = await resolver(host);
	} catch (error) {
		const lead =
			phase === "connect"
				? `the connect-time re-resolution of '${host}' failed (${describeDnsError(error)}) and the address the fetch would reach cannot be verified;`
				: `DNS resolution failed for '${host}' (${describeDnsError(error)});`;
		return {
			ok: false,
			reason:
				`Refusing fetch of '${rawUrl}' — ${lead} failing closed rather than fetching a host that may not exist ` +
				`or may rebind. If this host is genuinely required, allowlist it explicitly.`,
		};
	}
	if (addresses.length === 0) {
		const lead =
			phase === "connect"
				? `the connect-time re-resolution of '${host}' returned no addresses and the address the fetch would reach cannot be verified;`
				: `DNS resolution failed for '${host}' (the resolver returned no addresses);`;
		return {
			ok: false,
			reason:
				`Refusing fetch of '${rawUrl}' — ${lead} failing closed rather than fetching a host that may not exist ` +
				`or may rebind. If this host is genuinely required, allowlist it explicitly.`,
		};
	}
	for (const { address, family } of addresses) {
		const bad = family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
		if (bad) {
			const lead =
				phase === "connect"
					? `'${host}' re-resolved to '${address}', a private/reserved ${family === 4 ? "IPv4" : "IPv6"} address, ` +
						`at connect time (possible DNS rebinding); the answers changed between checks.`
					: `the target host '${host}' resolves to '${address}', a private/reserved ` +
						`${family === 4 ? "IPv4" : "IPv6"} address, which is unreachable or may be a local service;`;
			return {
				ok: false,
				reason:
					`Refusing fetch of '${rawUrl}' — ${lead} this is a common SSRF vector. ` +
					`If this host is genuinely required, allowlist it explicitly.`,
			};
		}
	}
	return { ok: true, addresses };
}

/** Decision for one fetch URL, with the verified addresses pinned when allowed. */
export async function checkUrlSafetyPinned(rawUrl: string, options: UrlSafetyOptions = {}): Promise<UrlGateVerdict> {
	const allowed = new Set(["http", "https", ...(options.allowedSchemes ?? [])]);

	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return {
			block: true,
			reason: `Refusing fetch of '${rawUrl}' — the URL is malformed and cannot be parsed safely.`,
		};
	}

	const scheme = url.protocol.replace(/:$/, "").toLowerCase();
	if (!allowed.has(scheme)) {
		const list = [...allowed].sort().join("/");
		return {
			block: true,
			reason: `Refusing fetch of '${rawUrl}' — scheme '${scheme}' is not allowed; only ${list} URLs are permitted.`,
		};
	}

	if (url.username || url.password) {
		return {
			block: true,
			reason: `Refusing fetch of '${rawUrl}' — embedding credentials in a URL is unsafe (SSRF / credential leak). Pass secrets separately, not in the URL.`,
		};
	}

	const host = normalizeHost(url.hostname);
	if (!host) return { block: true, reason: `Refusing fetch of '${rawUrl}' — the URL has no host.` };
	if (isAllowedHost(host, options.allowHosts)) return { block: false };

	const ip = isIP(host);
	if (ip === 4) {
		if (isPrivateIPv4(host)) {
			return {
				block: true,
				reason:
					`Refusing fetch of '${rawUrl}' — the target host '${host}' is a private/reserved IPv4 address, which is unreachable or may be a local service; ` +
					`this is a common SSRF vector. If this host is genuinely required, allowlist it explicitly.`,
			};
		}
		return { block: false }; // public literal: the address is known, no DNS needed
	}
	if (ip === 6) {
		if (isPrivateIPv6(host)) {
			return {
				block: true,
				reason:
					`Refusing fetch of '${rawUrl}' — the target host '${host}' is a private/reserved IPv6 address, which is unreachable or may be a local service; ` +
					`this is a common SSRF vector. If this host is genuinely required, allowlist it explicitly.`,
			};
		}
		return { block: false }; // public literal: the address is known, no DNS needed
	}

	// Named hostname.
	if (isLoopbackHostname(host)) {
		return {
			block: true,
			reason:
				`Refusing fetch of '${rawUrl}' — the target host '${host}' is a loopback/mDNS hostname, which is unreachable or may be a local service; ` +
				`this is a common SSRF vector. If this host is genuinely required, allowlist it explicitly.`,
		};
	}

	// ADR-0057: resolve named http(s) hosts and classify the resolved addresses.
	// Other allowed schemes (operator opt-in) keep the literal checks only.
	if (scheme !== "http" && scheme !== "https") return { block: false };

	const resolver = options.resolver ?? makeDefaultResolver(options.dnsTimeoutMs);
	const first = await resolveAndClassify(rawUrl, host, resolver, "check");
	if (!first.ok) return { block: true, reason: first.reason };

	// ADR-0066: re-resolve at connect time and re-check before allowing, and
	// pin the connect-time answer so fetchPinned connects to the CHECKED
	// addresses (the original Host header keeps virtual hosting and TLS
	// hostname verification working).
	const second = await resolveAndClassify(rawUrl, host, resolver, "connect");
	if (!second.ok) return { block: true, reason: second.reason };
	return { block: false, pin: { hostname: host, addresses: second.addresses } };
}

/** Decision for one fetch URL: `undefined` to allow, or a block with a reason. */
export async function checkUrlSafety(rawUrl: string, options: UrlSafetyOptions = {}): Promise<UrlSafeDecision> {
	const verdict = await checkUrlSafetyPinned(rawUrl, options);
	return verdict.block ? { block: true, reason: verdict.reason } : undefined;
}
