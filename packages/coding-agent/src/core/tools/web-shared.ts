import http from "node:http";
import https from "node:https";
import { VERSION } from "../../config.js";
import { buildPinnedRequestOptions, type PinnedFetcher } from "../../extensions/security/fetch-pinned.js";

/** Default search timeout (ms). Env: AXIOM_WEBSEARCH_TIMEOUT_MS. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 8000;
/** Default fetch timeout (ms). Env: AXIOM_WEBFETCH_TIMEOUT_MS. */
export const DEFAULT_FETCH_TIMEOUT_MS = 15000;
/** Default result count. Env: AXIOM_WEBSEARCH_MAX_RESULTS. */
export const DEFAULT_MAX_RESULTS = 5;
/** Hard ceiling on result count per search. */
export const MAX_RESULTS = 10;
/** Per-snippet char cap in search results. */
export const DEFAULT_SNIPPET_CAP = 200;
/** Default fetch content cap (chars). Env: AXIOM_WEBFETCH_MAX_CHARS. */
export const DEFAULT_FETCH_MAX_CHARS = 20000;
/** Minimum spacing between requests to the same engine host (ms). */
export const MIN_ENGINE_GAP_MS = 1000;
/** Total char budget for the search result block. */
export const MAX_SEARCH_BLOCK_CHARS = 4000;

export type WebSearchEngineName = "duckduckgo" | "bing";

export const SEARCH_ENGINE_URLS: Record<WebSearchEngineName, (query: string) => string> = {
	duckduckgo: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
	// url.parse needed: keep raw encoding from encodeURIComponent
	bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
};

export const SEARCH_ENGINE_HOSTS: Record<WebSearchEngineName, string> = {
	duckduckgo: "duckduckgo.com",
	// bing.com
	bing: "bing.com",
};

export function axiomUserAgent(): string {
	return `Axiom/${VERSION}`;
}

/** Parse a positive numeric env var; invalid or unset values fall back. */
export function resolveNumberEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") {
		return fallback;
	}
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Unwrap DuckDuckGo redirect wrappers (//duckduckgo.com/l/?uddg=<target>). */
export function unwrapDdgUrl(url: string): string {
	if (!url.includes("duckduckgo.com/l/?")) {
		return url;
	}
	const match = url.match(/[?&]uddg=([^&]+)/);
	if (!match) {
		return url;
	}
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return url;
	}
}

/** Strip all tags, collapse whitespace. Used on extracted text fragments. */
export function stripTagsInline(s: string): string {
	return s
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "\u2014",
	ndash: "\u2013",
	hellip: "\u2026",
	rsquo: "\u2019",
	lsquo: "\u2018",
	rdquo: "\u201d",
	ldquo: "\u201c",
	copy: "\u00a9",
	reg: "\u00ae",
	trade: "\u2122",
};

/** Decode the common HTML entities and numeric character references. */
export function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
		.replace(/&([a-zA-Z]+);/g, (full, name: string) => NAMED_ENTITIES[name] ?? full);
}

/**
 * Per-host minimum-gap rate limiter. Keeps polite spacing between requests
 * to the same engine host. Injectable clock and sleep for tests.
 */
export class EngineRateLimiter {
	private readonly lastHit = new Map<string, number>();

	constructor(
		private readonly minGapMs: number = MIN_ENGINE_GAP_MS,
		private readonly now: () => number = Date.now,
		private readonly sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
	) {}

	async acquire(host: string): Promise<void> {
		const now = this.now();
		const last = this.lastHit.get(host);
		if (last !== undefined) {
			const wait = this.minGapMs - (now - last);
			if (wait > 0) {
				await this.sleepFn(wait);
				this.lastHit.set(host, this.now());
				return;
			}
		}
		this.lastHit.set(host, now);
	}
}

/**
 * A pinned fetcher with header overrides and a timeout. Reuses the gate's
 * pin machinery (buildPinnedRequestOptions): the connection answers only the
 * pin, the Host header and TLS SNI stay original. On timeout the socket is
 * destroyed so nothing hangs.
 */
export function makeTimedPinnedFetcher(timeoutMs: number, headers?: Record<string, string>): PinnedFetcher {
	return async (url, pin) => {
		const base = buildPinnedRequestOptions(url, pin);
		const options = { ...base, headers: { ...base.headers, ...(headers ?? {}) } };
		const mod = url.protocol === "https:" ? https : http;
		return await new Promise<Response>((resolve, reject) => {
			const signal = AbortSignal.timeout(timeoutMs);
			const req = mod.request(options, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const resHeaders: Record<string, string> = {};
					for (const [key, value] of Object.entries(res.headers)) {
						if (typeof value === "string") {
							resHeaders[key] = value;
						} else if (Array.isArray(value)) {
							resHeaders[key] = value.join(", ");
						}
					}
					resolve(
						new Response(Buffer.concat(chunks), {
							status: res.statusCode ?? 502,
							statusText: res.statusMessage ?? "",
							headers: resHeaders,
						}),
					);
				});
				res.on("error", reject);
			});
			signal.addEventListener("abort", () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
			req.on("error", reject);
			req.end();
		});
	};
}
