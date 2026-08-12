import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import { createSecurityFence } from "../../src/extensions/security/index.js";

/** Minimal fake ExtensionAPI capturing handlers so a test can invoke them (workspace pattern). */
function fakePi(): { pi: ExtensionAPI; toolCall: (event: Record<string, unknown>) => Promise<unknown> } {
	const handlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
	return {
		pi: {
			on: (evt: string, h: (...a: unknown[]) => unknown) => handlers.set(evt, [...(handlers.get(evt) ?? []), h]),
		} as unknown as ExtensionAPI,
		toolCall: async (event) => {
			let result: unknown;
			for (const h of handlers.get("tool_call") ?? []) {
				result = await h(event, undefined);
				if (result && (result as { block?: boolean }).block) break;
			}
			return result;
		},
	};
}

describe("createSecurityFence wiring", () => {
	it("blocks a URL-bearing tool call whose URL is unsafe, when anchored", async () => {
		const { pi, toolCall } = fakePi();
		createSecurityFence({ root: "/srv/proj" })(pi);
		const res = (await toolCall({
			type: "tool_call",
			toolName: "fetch",
			toolCallId: "1",
			input: { url: "http://169.254.169.254/latest/meta-data" },
		})) as { block: boolean; reason: string };
		expect(res.block).toBe(true);
		expect(res.reason).toMatch(/SSRF|address/i);
	});
	it("allows an anchored URL-bearing call with a safe URL and no sensitive rule", async () => {
		const { pi, toolCall } = fakePi();
		createSecurityFence({ root: "/srv/proj" })(pi);
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
		const res = (await toolCall({
			type: "tool_call",
			toolName: "ext_publish",
			toolCallId: "3",
			input: {},
		})) as { block: true; reason: string };
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
	it("honors AXIOM_PLACEHOLDER host-allowlist via options (gated URL passes)", async () => {
		const { pi, toolCall } = fakePi();
		createSecurityFence({ root: "/srv/proj", allowHosts: ["127.0.0.1"] })(pi);
		expect(
			await toolCall({
				type: "tool_call",
				toolName: "fetch",
				toolCallId: "7",
				input: { url: "http://127.0.0.1:3000/x" },
			}),
		).toBeUndefined();
	});
});
