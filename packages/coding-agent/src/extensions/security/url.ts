/**
 * URL-safe fetch gate — pure URL safety (ADR-0028, security fence).
 *
 * The egress half of the security fence: any tool call that carries a `url`
 * argument (a fetch channel) is poked through `checkUrlSafety` before it runs
 * on an anchored project. Rejects, with a plain-English reason surfaced to the
 * model:
 *  - malformed URLs,
 *  - non-http(s) schemes (file:, data:, javascript:, ftp:, gopher:, ...),
 *  - URLs embedding credentials (SSRF/credential-leak vector),
 *  - SSRF-prone host literals: loopback / private / link-local / ULA / v4-mapped
 *    IPv4+IPv6, and loopback-patterned hostnames (localhost, *.localhost, *.local).
 *
 * Honest boundary (recorded, not faked): arbitrary NAMED hostnames are allowed —
 * proving a name resolves to a private address requires DNS, which this pure,
 * sync, unit-testable module deliberately does not perform. DNS resolution is a
 * documented follow-up. Host literals and loopback-patterned names are caught
 * here without any network.
 */
import { isIP } from "node:net";

export interface UrlSafetyOptions {
	/** Extra schemes allowed beyond http/https (default: none). */
	allowedSchemes?: string[];
	/** Hosts (hostname or IP literal, brackets stripped) always allowed even if private/loopback. */
	allowHosts?: string[];
}

export type UrlSafeDecision = { block: true; reason: string } | undefined;

/** True iff `host` (lowercased, bracket-stripped) is explicitly allowlisted. */
function isAllowedHost(host: string, allowHosts?: string[]): boolean {
	if (!allowHosts || allowHosts.length === 0) return false;
	return allowHosts.some((h) => normalizeHost(h) === host);
}

function normalizeHost(host: string): string {
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

/** Extract a trailing dotted-quad from a v4-mapped IPv6 (e.g. "::ffff:192.168.1.1"). */
function extractDottedV4(addr: string): string | undefined {
	const m = /\d{1,3}(?:\.\d{1,3}){3}$/.exec(addr);
	return m?.[0];
}

/** Classify an IPv6 literal against private/reserved ranges. */
export function isPrivateIPv6(addr: string): boolean {
	const s = normalizeHost(addr).split("%")[0]; // strip zone id (fe80::1%eth0)
	// v4-mapped / v4-embedded with a dotted tail
	const dotted = extractDottedV4(s);
	if (dotted) return isPrivateIPv4(dotted);
	// v4-mapped in pure hextet form (::ffff:c0a8:0101)
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

/** Decision for one fetch URL: `undefined` to allow, or a block with a reason. */
export function checkUrlSafety(rawUrl: string, options: UrlSafetyOptions = {}): UrlSafeDecision {
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
	if (isAllowedHost(host, options.allowHosts)) return undefined;

	const ip = isIP(host);
	let bad = false;
	let danger: string;
	switch (ip) {
		case 4:
			bad = isPrivateIPv4(host);
			danger = "private/reserved IPv4 address";
			break;
		case 6:
			bad = isPrivateIPv6(host);
			danger = "private/reserved IPv6 address";
			break;
		default:
			bad = isLoopbackHostname(host);
			danger = "loopback/mDNS hostname";
			break;
	}

	if (bad) {
		return {
			block: true,
			reason:
				`Refusing fetch of '${rawUrl}' — the target host '${host}' is a ${danger}, which is unreachable or may be a local service; ` +
				`this is a common SSRF vector. If this host is genuinely required, allowlist it explicitly.`,
		};
	}
	return undefined;
}
