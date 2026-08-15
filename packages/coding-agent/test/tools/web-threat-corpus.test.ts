/**
 * S-class threat corpus - native web fetch tool (ADR-0074, issue #50).
 *
 * Permanent attack cases for the web_fetch core tool. Every case names the
 * attack it neutralizes and must fail on code that predates the tool. All
 * cases run offline: the pinned fetcher is injected, and DNS-aware cases
 * inject their own resolver through the ADR-0057 seam.
 */

import { describe, expect, it } from "vitest";
import { createWebFetchTool } from "../../src/core/tools/web-fetch.js";
import type { PinnedFetcher } from "../../src/extensions/security/fetch-pinned.js";
import type { HostnameResolver } from "../../src/extensions/security/url.js";

const PUBLIC = "93.184.216.34";

function getText(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") ?? ""
	);
}

const OK_HTML = "<html><head><title>Safe</title></head><body><p>hello from the public web</p></body></html>";

function okFetcher(): PinnedFetcher {
	return async (_url, _pin) => new Response(OK_HTML, { status: 200 });
}

function resolverReturning(addresses: string[]): HostnameResolver {
	return async () => addresses.map((address) => ({ address, family: 4 }));
}

describe("web fetch S-class threat corpus", () => {
	it("S1: file scheme is blocked", async () => {
		const tool = createWebFetchTool(process.cwd(), { fetcher: okFetcher() });
		await expect(tool.execute("s1", { url: "file:///etc/passwd" })).rejects.toThrow(/blocked/);
	});

	it("S2: javascript scheme is blocked", async () => {
		const tool = createWebFetchTool(process.cwd(), { fetcher: okFetcher() });
		await expect(tool.execute("s2", { url: "javascript:alert(1)" })).rejects.toThrow(/blocked/);
	});

	it("S3: loopback literal is blocked", async () => {
		const tool = createWebFetchTool(process.cwd(), { fetcher: okFetcher() });
		await expect(tool.execute("s3", { url: "http://127.0.0.1:3000/admin" })).rejects.toThrow(/blocked/);
	});

	it("S4: link-local metadata address is blocked", async () => {
		const tool = createWebFetchTool(process.cwd(), { fetcher: okFetcher() });
		await expect(tool.execute("s4", { url: "http://169.254.169.254/latest/meta-data" })).rejects.toThrow(/blocked/);
	});

	it("S5: urls with embedded credentials are blocked", async () => {
		const tool = createWebFetchTool(process.cwd(), { fetcher: okFetcher() });
		await expect(tool.execute("s5", { url: "https://user:pass@example.com/" })).rejects.toThrow(/blocked/);
	});

	it("S6: named host resolving to a private address is blocked", async () => {
		const tool = createWebFetchTool(process.cwd(), {
			fetcher: okFetcher(),
			gateOptions: { resolver: resolverReturning(["10.0.0.5"]) },
		});
		await expect(tool.execute("s6", { url: "https://internal.example.com/" })).rejects.toThrow(/blocked/);
	});

	it("S7: resolver flipping public to private between check and re-check is blocked", async () => {
		let calls = 0;
		const flipResolver: HostnameResolver = async () => {
			calls += 1;
			return [{ address: calls === 1 ? PUBLIC : "10.0.0.7", family: 4 }];
		};
		const tool = createWebFetchTool(process.cwd(), {
			fetcher: okFetcher(),
			gateOptions: { resolver: flipResolver },
		});
		await expect(tool.execute("s7", { url: "https://flip.example.com/" })).rejects.toThrow(/blocked/);
		expect(calls).toBeGreaterThanOrEqual(2);
	});

	it("S8: public hosts pass the gate and the pinned addresses reach the fetcher", async () => {
		let seenPin: { hostname: string; addresses: string[] } | undefined;
		const recorder: PinnedFetcher = async (_url, pin) => {
			seenPin = { hostname: pin?.hostname ?? "", addresses: pin?.addresses.map((a) => a.address) ?? [] };
			return new Response(OK_HTML, { status: 200 });
		};
		const tool = createWebFetchTool(process.cwd(), {
			fetcher: recorder,
			gateOptions: { resolver: resolverReturning([PUBLIC]) },
		});
		const result = await tool.execute("s8", { url: "https://public.example.com/" });
		expect(seenPin?.hostname).toBe("public.example.com");
		expect(seenPin?.addresses).toEqual([PUBLIC]);
		expect(getText(result)).toContain("hello from the public web");
	});

	it("S9: fetched content is hard-capped at maxChars", async () => {
		const big = "<html><head><title>Big</title></head><body><p>" + "z".repeat(5000) + "</p></body></html>";
		const fetcher: PinnedFetcher = async () => new Response(big, { status: 200 });
		const tool = createWebFetchTool(process.cwd(), {
			fetcher,
			maxChars: 100,
			gateOptions: { resolver: resolverReturning([PUBLIC]) },
		});
		const result = await tool.execute("s9", { url: "https://public.example.com/big" });
		expect(result.details.truncated).toBe(true);
		expect(getText(result).length).toBeLessThan(400);
	});
});
