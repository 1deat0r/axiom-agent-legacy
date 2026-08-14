/**
 * Pinned fetch (ADR-0066) — the gate-owned fetch that closes the DNS
 * rebinding TOCTOU: the address the fetch connects to is the address the
 * gate checked.
 *
 * `checkUrlSafetyPinned` verifies a named http(s) host twice (check +
 * connect-time re-check) and pins the connect-time answer. `fetchPinned`
 * then connects to those pinned addresses with the ORIGINAL Host header:
 * the request options keep `hostname` (Host header, virtual hosting) and
 * `servername` (TLS SNI and certificate verification) while the injected
 * `lookup` answers only the pin — no fresh resolution, so a resolver that
 * flips answers after the gate can no longer redirect the connection.
 *
 * Redirects are followed manually: every Location hop is re-gated (and
 * re-pinned) before it is fetched, so a public URL that redirects to a
 * loopback/private target is blocked before the second connection. The
 * default fetcher uses node:http/https with a `lookup` override (no new
 * dependencies); `fetcher` and `gate` are injectable seams so tests stay
 * offline.
 */
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import type { RequestOptions } from "node:http";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import {
	checkUrlSafetyPinned,
	normalizeHost,
	type PinnedResolution,
	type UrlGateVerdict,
	type UrlSafetyOptions,
} from "./url.js";

/** Maximum manual redirect hops before `fetchPinned` fails closed. */
export const DEFAULT_MAX_REDIRECTS = 5;

/** A block from the URL gate surfaced as an error so a caller cannot use the response. */
export class UrlGateBlockError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "UrlGateBlockError";
	}
}

/** Fetch seam: performs one hop's request against the pin. Never follows redirects itself. */
export type PinnedFetcher = (url: URL, pin: PinnedResolution | undefined) => Promise<Response>;

/** Gate seam: re-verifies the initial URL and every redirect hop. */
export type GateFn = (rawUrl: string, options: UrlSafetyOptions) => Promise<UrlGateVerdict>;

export interface FetchPinnedOptions extends UrlSafetyOptions {
	/** Manual redirect budget (default `DEFAULT_MAX_REDIRECTS`). */
	maxRedirects?: number;
	/** One-hop fetcher seam (tests). Default: node http/https against the pin. */
	fetcher?: PinnedFetcher;
	/** Gate seam (tests). Default: `checkUrlSafetyPinned`. */
	gate?: GateFn;
}

/** Request options for one pinned hop: the hostname stays original, the lookup answers only the pin. */
export interface PinnedRequestOptions extends RequestOptions {
	hostname: string;
	port: number;
	path: string;
	lookup: LookupFunction;
	/** TLS SNI + certificate-verification hostname (https only). */
	servername?: string;
	/** Never set to false: node's default certificate verification stays on. */
	rejectUnauthorized?: boolean;
}

/** Default net lookup for pin-less hops (IP literals, allowlisted hosts). */
export function defaultNetLookup(
	hostname: string,
	_options: unknown,
	callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
	dnsLookup(hostname, { all: true }).then(
		(addrs) => callback(null, addrs),
		(err: unknown) => callback(err as NodeJS.ErrnoException, []),
	);
}

/**
 * A `net` lookup that answers the pin for the pinned hostname and delegates
 * anything else to the fallback (default: the system resolver). The fetch
 * never resolves the pinned hostname itself — rebinding has nothing to flip.
 */
export function makePinningLookup(pin: PinnedResolution, fallback: LookupFunction = defaultNetLookup): LookupFunction {
	return (hostname, options, callback) => {
		if (normalizeHost(hostname) === pin.hostname) {
			const mapped: LookupAddress[] = pin.addresses.map((a) => ({ address: a.address, family: a.family }));
			queueMicrotask(() => callback(null, mapped));
			return;
		}
		fallback(hostname, options, callback);
	};
}

/**
 * Build the request options for one pinned hop. The connection goes to the
 * pin (lookup), the request speaks the original hostname (Host header) and,
 * for https, the original servername (SNI + certificate verification). All
 * pinned addresses are returned so multi-IP hosts keep their whole pool.
 */
export function buildPinnedRequestOptions(url: URL, pin: PinnedResolution | undefined): PinnedRequestOptions {
	const secure = url.protocol === "https:";
	const port = url.port ? Number(url.port) : secure ? 443 : 80;
	return {
		protocol: url.protocol,
		hostname: url.hostname,
		port,
		path: url.pathname + url.search,
		method: "GET",
		headers: { accept: "*/*", "user-agent": "axiom-url-gate/1" },
		lookup: pin ? makePinningLookup(pin) : defaultNetLookup,
		...(secure ? { servername: url.hostname } : {}),
	};
}

/** One hop against the pin using node:http/https (buffered body; GET only). */
export async function defaultPinnedFetcher(url: URL, pin: PinnedResolution | undefined): Promise<Response> {
	const secure = url.protocol === "https:";
	const mod = secure ? https : http;
	const options = buildPinnedRequestOptions(url, pin);
	return await new Promise<Response>((resolve, reject) => {
		const req = mod.request(options, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const headers: Record<string, string> = {};
				for (const [key, value] of Object.entries(res.headers)) {
					if (typeof value === "string") headers[key] = value;
					else if (Array.isArray(value)) headers[key] = value.join(", ");
				}
				resolve(
					new Response(Buffer.concat(chunks), {
						status: res.statusCode ?? 502,
						statusText: res.statusMessage ?? "",
						headers,
					}),
				);
			});
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end();
	});
}

/**
 * Gate, pin, fetch — and re-gate every redirect hop before it connects.
 * Returns the final response, or throws `UrlGateBlockError` when the
 * initial URL or any redirect target fails the gate (or the chain exceeds
 * `maxRedirects`). Connection errors from the fetcher propagate unchanged.
 */
export async function fetchPinned(rawUrl: string, options: FetchPinnedOptions = {}): Promise<Response> {
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const gate = options.gate ?? checkUrlSafetyPinned;
	const fetcher = options.fetcher ?? defaultPinnedFetcher;
	const gateOptions: UrlSafetyOptions = {
		resolver: options.resolver,
		dnsTimeoutMs: options.dnsTimeoutMs,
		allowHosts: options.allowHosts,
		allowedSchemes: options.allowedSchemes,
	};

	let current = rawUrl;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		const verdict = await gate(current, gateOptions);
		if (verdict.block) throw new UrlGateBlockError(verdict.reason);
		const url = new URL(current);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new UrlGateBlockError(
				`Refusing fetch of '${current}' — the pinned fetch only connects over http(s); scheme '${url.protocol.replace(/:$/, "")}' is unsupported.`,
			);
		}
		const response = await fetcher(url, verdict.pin);
		if (response.status < 300 || response.status >= 400) return response;
		const location = response.headers.get("location");
		if (!location) return response;
		const next = new URL(location, url).toString();
		if (hop === maxRedirects) {
			throw new UrlGateBlockError(
				`Refusing fetch of '${rawUrl}' — the redirect chain exceeded ${maxRedirects} hops (last target '${next}'); possible redirect loop.`,
			);
		}
		current = next;
	}
	throw new UrlGateBlockError(
		`Refusing fetch of '${rawUrl}' — the redirect chain exceeded ${maxRedirects} hops; possible redirect loop.`,
	);
}
