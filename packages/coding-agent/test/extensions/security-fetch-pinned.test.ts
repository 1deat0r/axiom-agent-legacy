/**
 * Pinned-fetch unit suite (ADR-0066) — the gate-owned fetch that connects to
 * the CHECKED addresses with the original Host header.
 *
 * Offline by construction: the fake-socket cases inject the `fetcher` / `gate`
 * seams, and the single real-socket case binds a loopback server and pins to
 * it directly (a mechanism test, not a policy test — the gate never runs in
 * that case). No case reaches the public network.
 */
import type { LookupAddress } from "node:dns";
import { createServer } from "node:http";
import type { LookupFunction } from "node:net";
import { describe, expect, it } from "vitest";
import {
	buildPinnedRequestOptions,
	defaultPinnedFetcher,
	fetchPinned,
	makePinningLookup,
	type PinnedFetcher,
	UrlGateBlockError,
} from "../../src/extensions/security/fetch-pinned.js";
import type { PinnedResolution, UrlGateVerdict } from "../../src/extensions/security/url.js";

function pin(address = "127.0.0.1", hostname = "pinned.example"): PinnedResolution {
	return { hostname, addresses: [{ address, family: 4 }] };
}

function lookupOnce(lookup: LookupFunction, hostname: string): Promise<LookupAddress[]> {
	return new Promise((resolve, reject) => {
		lookup(hostname, {}, (err, addrs) => (err ? reject(err) : resolve(addrs as LookupAddress[])));
	});
}

describe("makePinningLookup", () => {
	it("answers the pin for the pinned hostname", async () => {
		const lookup = makePinningLookup(pin("8.8.8.8", "target.example"));
		await expect(lookupOnce(lookup, "target.example")).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
	});
	it("delegates other hostnames to the fallback lookup", async () => {
		const fallback: LookupFunction = (_hostname, _options, callback) => {
			callback(null, [{ address: "9.9.9.9", family: 4 }]);
		};
		const lookup = makePinningLookup(pin("8.8.8.8", "target.example"), fallback);
		await expect(lookupOnce(lookup, "other.example")).resolves.toEqual([{ address: "9.9.9.9", family: 4 }]);
	});
	it("returns every pinned address so multi-IP hosts keep their whole pool", async () => {
		const lookup = makePinningLookup({
			hostname: "multi.example",
			addresses: [
				{ address: "1.1.1.1", family: 4 },
				{ address: "1.0.0.1", family: 4 },
			],
		});
		await expect(lookupOnce(lookup, "multi.example")).resolves.toEqual([
			{ address: "1.1.1.1", family: 4 },
			{ address: "1.0.0.1", family: 4 },
		]);
	});
});

describe("buildPinnedRequestOptions", () => {
	it("keeps the original hostname and port while the lookup returns only the pin", () => {
		const options = buildPinnedRequestOptions(new URL("http://mustbearn:9981/steal"), pin("8.8.8.8", "mustbearn"));
		expect(options.hostname).toBe("mustbearn");
		expect(options.port).toBe(9981);
		expect(options.path).toBe("/steal");
	});
	it("defaults ports per scheme and sets servername for https", () => {
		const httpOptions = buildPinnedRequestOptions(new URL("http://p.example/"), pin("8.8.8.8", "p.example"));
		expect(httpOptions.port).toBe(80);
		expect(httpOptions.servername).toBeUndefined();
		const httpsOptions = buildPinnedRequestOptions(new URL("https://p.example/"), pin("8.8.8.8", "p.example"));
		expect(httpsOptions.port).toBe(443);
		expect(httpsOptions.servername).toBe("p.example");
		expect(httpsOptions.rejectUnauthorized).toBeUndefined(); // never disabled: node's default verification stays on
	});
});

describe("defaultPinnedFetcher (real node:http socket against a loopback server)", () => {
	it("connects to the pin and sends the original Host header", async () => {
		const server = createServer((req, res) => {
			res.setHeader("x-seen-host", req.headers.host ?? "");
			res.end("pinned-ok");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		try {
			// Pin the URL hostname to the loopback server address directly:
			// the connection must go to the pin while the Host header keeps
			// the original hostname.
			const response = await defaultPinnedFetcher(
				new URL(`http://pinned.example:${port}/data`),
				pin("127.0.0.1", "pinned.example"),
			);
			expect(response.status).toBe(200);
			await expect(response.text()).resolves.toBe("pinned-ok");
			expect(response.headers.get("x-seen-host")).toBe(`pinned.example:${port}`);
		} finally {
			server.close();
		}
	});
});

describe("UrlGateBlockError", () => {
	it("carries the gate reason", () => {
		const err = new UrlGateBlockError("blocked: loopback");
		expect(err.name).toBe("UrlGateBlockError");
		expect(err.message).toBe("blocked: loopback");
	});
});

describe("fetchPinned (gate + redirect re-gating)", () => {
	it("returns the response when the gate allows and the status is final", async () => {
		const fetcher: PinnedFetcher = async () => new Response("ok", { status: 200 });
		const response = await fetchPinned("https://8.8.8.8/", {
			fetcher,
			gate: async () => ({ block: false }),
		});
		expect(response.status).toBe(200);
	});
	it("throws UrlGateBlockError when the initial URL is blocked", async () => {
		const gate = async (): Promise<UrlGateVerdict> => ({ block: true, reason: "blocked: loopback" });
		await expect(fetchPinned("http://127.0.0.1/", { fetcher: async () => new Response("x"), gate })).rejects.toThrow(
			UrlGateBlockError,
		);
		await expect(fetchPinned("http://127.0.0.1/", { fetcher: async () => new Response("x"), gate })).rejects.toThrow(
			/loopback/,
		);
	});
	it("resolves relative redirects against the current URL and re-gates each hop", async () => {
		const gated: string[] = [];
		const gate = async (rawUrl: string): Promise<UrlGateVerdict> => {
			gated.push(rawUrl);
			return { block: false };
		};
		const fetcher: PinnedFetcher = async (url) =>
			url.pathname === "/start"
				? new Response("moved", { status: 302, headers: { location: "/next" } })
				: new Response("landed", { status: 200 });
		const response = await fetchPinned("http://public.example/start", { gate, fetcher });
		expect(response.status).toBe(200);
		expect(gated).toEqual(["http://public.example/start", "http://public.example/next"]);
	});
	it("caps the redirect chain and throws when it exceeds maxRedirects", async () => {
		const gate = async (): Promise<UrlGateVerdict> => ({ block: false });
		const fetcher: PinnedFetcher = async () =>
			new Response("moved", { status: 302, headers: { location: "/again" } });
		await expect(fetchPinned("http://loop.example/", { gate, fetcher, maxRedirects: 2 })).rejects.toThrow(
			/redirect chain/i,
		);
	});
	it("returns a redirect response as-is when it carries no Location header", async () => {
		const gate = async (): Promise<UrlGateVerdict> => ({ block: false });
		const fetcher: PinnedFetcher = async () => new Response("", { status: 300 });
		const response = await fetchPinned("http://x.example/", { gate, fetcher });
		expect(response.status).toBe(300);
	});
});
