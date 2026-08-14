import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import { createSecurityFence } from "../../src/extensions/security/index.js";
import type { HostnameResolver } from "../../src/extensions/security/url.js";

/** Minimal fake ExtensionAPI capturing handlers so a test can invoke them (workspace pattern). */
function fakePi(): { pi: ExtensionAPI; toolCall: (event: Record<string, unknown>) => Promise<unknown> } {
	const handlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
	return {
		pi: fromAny<ExtensionAPI, unknown>({
			on: (evt: string, h: (...a: unknown[]) => unknown) => handlers.set(evt, [...(handlers.get(evt) ?? []), h]),
		}),
		toolCall: async (event) => {
			let result: unknown;
			for (const h of handlers.get("tool_call") ?? []) {
				result = await h(event, undefined);
				if (result && fromPartial<{ block?: boolean }>(result).block) break;
			}
			return result;
		},
	};
}

/** Stub resolvers keep the DNS-aware URL gate wiring tests offline (ADR-0057). */
function publicResolver(): HostnameResolver {
	return async (_hostname) => [{ address: "8.8.8.8", family: 4 }];
}
function privateResolver(): HostnameResolver {
	return async (_hostname) => [{ address: "10.0.0.5", family: 4 }];
}

describe("createSecurityFence wiring", () => {
	it("blocks a URL-bearing tool call whose URL is unsafe, when anchored", async () => {
		const { pi, toolCall } = fakePi();
		createSecurityFence({ root: "/srv/proj" })(pi);
		const res = fromAny<{ block: boolean; reason: string }, unknown>(
			await toolCall({
				type: "tool_call",
				toolName: "fetch",
				toolCallId: "1",
				input: { url: "http://169.254.169.254/latest/meta-data" },
			}),
		);
		expect(res.block).toBe(true);
		expect(res.reason).toMatch(/SSRF|address/i);
	});
	it("blocks an anchored URL-bearing call whose named host resolves private", async () => {
		const { pi, toolCall } = fakePi();
		createSecurityFence({ root: "/srv/proj", resolver: privateResolver() })(pi);
		const res = fromAny<{ block: boolean; reason: string }, unknown>(
			await toolCall({
				type: "tool_call",
				toolName: "fetch",
				toolCallId: "1b",
				input: { url: "https://intranet.corp/admin" },
			}),
		);
		expect(res.block).toBe(true);
		expect(res.reason).toMatch(/SSRF|private/i);
	});
	it("allows an anchored URL-bearing call with a safe URL and no sensitive rule", async () => {
		const { pi, toolCall } = fakePi();
		createSecurityFence({ root: "/srv/proj", resolver: publicResolver() })(pi);
		expect(
			await toolCall({
				type: "tool_call",
				toolName: "fetch",
				toolCallId: "2",
				input: { url: "https://example.com/x" },
			}),
		).toBeUndefined();
	});
	it("blocks a configured sensitive tool unless approved, when anchored", async () => {
		const { pi, toolCall } = fakePi();
		createSecurityFence({ root: "/srv/proj", sensitiveTools: ["ext_publish"] })(pi);
		const res = fromAny<{ block: true; reason: string }, unknown>(
			await toolCall({
				type: "tool_call",
				toolName: "ext_publish",
				toolCallId: "3",
				input: {},
			}),
		);
		expect(res.block).toBe(true);
		expect(res.reason).toMatch(/approved-tool fence/i);
	});
	it("is inert without a project root — ordinary run passes through untouched", async () => {
		const { pi, toolCall } = fakePi();
		createSecurityFence()(pi); // no AXIOM_PROJECT_ROOT, no deps.root
		expect(
			await toolCall({ type: "tool_call", toolName: "edit", toolCallId: "4", input: { path: "/etc/passwd" } }),
		).toBeUndefined();
	});
	it("back-compat: anchored run with no url field and no sensitive tools passes through", async () => {
		const { pi, toolCall } = fakePi();
		createSecurityFence({ root: "/srv/proj" })(pi);
		expect(
			await toolCall({ type: "tool_call", toolName: "edit", toolCallId: "5", input: { path: "a.ts" } }),
		).toBeUndefined();
		expect(
			await toolCall({ type: "tool_call", toolName: "bash", toolCallId: "6", input: { command: "ls" } }),
		).toBeUndefined();
	});
	it("honors an explicit host allowlist via options (resolution skipped)", async () => {
		const { pi, toolCall } = fakePi();
		createSecurityFence({
			root: "/srv/proj",
			allowHosts: ["127.0.0.1", "intranet.corp"],
			resolver: privateResolver(),
		})(pi);
		expect(
			await toolCall({
				type: "tool_call",
				toolName: "fetch",
				toolCallId: "7",
				input: { url: "http://127.0.0.1:3000/x" },
			}),
		).toBeUndefined();
		expect(
			await toolCall({
				type: "tool_call",
				toolName: "fetch",
				toolCallId: "8",
				input: { url: "http://intranet.corp/x" },
			}),
		).toBeUndefined();
	});
});
