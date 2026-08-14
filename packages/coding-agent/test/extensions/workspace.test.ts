import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import { appendGrant, listAudit, resolveScopeDir } from "../../src/core/root-guard/store.js";
import { createWorkspaceGuard, isWithin, realpathX } from "../../src/extensions/workspace/index.js";

/** Minimal fake ExtensionAPI that captures handlers so a test can invoke them. */
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

async function makeRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "axiom-ws-"));
}

describe("isWithin (pure containment)", () => {
	it("allows a child path and the root itself", () => {
		expect(isWithin("/root/proj", "/root/proj/src/a.ts")).toBe(true);
		expect(isWithin("/root/proj", "/root/proj")).toBe(true);
	});
	it("blocks a sibling that merely shares a prefix", () => {
		expect(isWithin("/tmp/root", "/tmp/root2/x")).toBe(false);
	});
	it("blocks an ancestor and an outside escape", () => {
		expect(isWithin("/root/proj", "/root/other")).toBe(false);
		expect(isWithin("/root/proj", "/tmp/x")).toBe(false);
	});
	it("blocks a dotted escape", () => {
		expect(isWithin("/root/proj", "/root/proj/../../etc/passwd")).toBe(false);
	});
});

describe("realpathX", () => {
	it("resolves an existing file and its symlink target", async () => {
		const root = await makeRoot();
		try {
			await writeFile(join(root, "real.txt"), "x");
			await symlink(join(root, "real.txt"), join(root, "link.txt"));
			const realLink = await realpathX(join(root, "link.txt"));
			expect(realLink).toBe(join(root, "real.txt"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("resolves a not-yet-created file to its nearest existing ancestor", async () => {
		const root = await makeRoot();
		try {
			expect(await realpathX(join(root, "new", "deep", "f.ts"))).toBe(join(root, "new", "deep", "f.ts"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("workspace guard tool_call handler", () => {
	it("allows an edit path inside the project root (EXISTING relative + new absolute)", async () => {
		const root = await makeRoot();
		try {
			await writeFile(join(root, "a.ts"), "x");
			const { pi, toolCall } = fakePi();
			createWorkspaceGuard({ root, cwd: root })(pi);
			expect(
				await toolCall({
					type: "tool_call",
					toolName: "edit",
					toolCallId: "1",
					input: { path: "a.ts", edits: [] },
				}),
			).toBeUndefined();
			expect(
				await toolCall({
					type: "tool_call",
					toolName: "edit",
					toolCallId: "2",
					input: { path: join(root, "newfile.ts"), edits: [] },
				}),
			).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("blocks an edit that resolves outside the root, with a reason naming the root", async () => {
		const root = await makeRoot();
		try {
			await writeFile(join(root, "a.ts"), "x");
			const { pi, toolCall } = fakePi();
			createWorkspaceGuard({ root, cwd: root })(pi);
			const res = fromAny<{ block: boolean; reason: string }, unknown>(
				await toolCall({
					type: "tool_call",
					toolName: "edit",
					toolCallId: "3",
					input: { path: "../outside.ts", edits: [] },
				}),
			);
			expect(res.block).toBe(true);
			expect(res.reason).toContain(root);
			expect(res.reason).toMatch(/outside/i);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("blocks an absolute edit path outside the root", async () => {
		const other = await makeRoot();
		const root = await makeRoot();
		try {
			const { pi, toolCall } = fakePi();
			createWorkspaceGuard({ root, cwd: root })(pi);
			const res = fromAny<{ block: boolean }, unknown>(
				await toolCall({
					type: "tool_call",
					toolName: "edit",
					toolCallId: "4",
					input: { path: join(other, "victim.ts"), edits: [] },
				}),
			);
			expect(res.block).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(other, { recursive: true, force: true });
		}
	});

	it("blocks a symlink whose target escapes the root", async () => {
		const other = await makeRoot();
		const root = await makeRoot();
		try {
			await writeFile(join(other, "secret.ts"), "secret");
			await symlink(join(other, "secret.ts"), join(root, "link.ts"));
			const { pi, toolCall } = fakePi();
			createWorkspaceGuard({ root, cwd: root })(pi);
			const res = fromAny<{ block: boolean }, unknown>(
				await toolCall({
					type: "tool_call",
					toolName: "edit",
					toolCallId: "5",
					input: { path: "link.ts", edits: [] },
				}),
			);
			expect(res.block).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(other, { recursive: true, force: true });
		}
	});

	it("is inert without a project root and for non-edit tools even when anchored", async () => {
		const root = await makeRoot();
		try {
			const { pi, toolCall } = fakePi();
			createWorkspaceGuard()(pi); // no AXIOM_PROJECT_ROOT, no deps.root
			expect(
				await toolCall({
					type: "tool_call",
					toolName: "edit",
					toolCallId: "6",
					input: { path: "../x.ts", edits: [] },
				}),
			).toBeUndefined();

			const { pi: pi2, toolCall: tc2 } = fakePi();
			createWorkspaceGuard({ root, cwd: root })(pi2);
			expect(
				await tc2({
					type: "tool_call",
					toolName: "bash",
					toolCallId: "7",
					input: { command: "cd .. && rm -rf /tmp" },
				}),
			).toBeUndefined(); // freeform tools are the documented OS-tier boundary
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses AXIOM_PROJECT_ROOT from the environment when no deps.root is given", async () => {
		const root = await makeRoot();
		const prev = process.env.AXIOM_PROJECT_ROOT;
		try {
			process.env.AXIOM_PROJECT_ROOT = root;
			const { pi, toolCall } = fakePi();
			createWorkspaceGuard()(pi);
			expect(
				await toolCall({
					type: "tool_call",
					toolName: "edit",
					toolCallId: "8",
					input: { path: "../escape.ts", edits: [] },
				}),
			).toMatchObject({ block: true });
		} finally {
			if (prev === undefined) delete process.env.AXIOM_PROJECT_ROOT;
			else process.env.AXIOM_PROJECT_ROOT = prev;
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("workspace guard approval escapes (ADR-0052)", () => {
	it("allows an outside edit when the path matches an allow prefix", async () => {
		const root = await makeRoot();
		const other = await makeRoot();
		try {
			const { pi, toolCall } = fakePi();
			createWorkspaceGuard({ root, cwd: root, allowPrefixes: [other] })(pi);
			expect(
				await toolCall({
					type: "tool_call",
					toolName: "edit",
					toolCallId: "9",
					input: { path: join(other, "x.ts"), edits: [] },
				}),
			).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(other, { recursive: true, force: true });
		}
	});

	it("still blocks an outside edit when no prefix matches", async () => {
		const root = await makeRoot();
		const other = await makeRoot();
		try {
			const { pi, toolCall } = fakePi();
			createWorkspaceGuard({ root, cwd: root, allowPrefixes: [join(root, "elsewhere")] })(pi);
			const res = fromAny<{ block: boolean; reason: string }, unknown>(
				await toolCall({
					type: "tool_call",
					toolName: "edit",
					toolCallId: "10",
					input: { path: join(other, "x.ts"), edits: [] },
				}),
			);
			expect(res.block).toBe(true);
			expect(res.reason).toMatch(/request_root_access/);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(other, { recursive: true, force: true });
		}
	});

	it("honors an operator-approved grant from the shared store", async () => {
		const root = await makeRoot();
		const other = await makeRoot();
		const state = await makeRoot();
		const prev = process.env.AXIOM_ROOT_GUARD_STATE_DIR;
		try {
			process.env.AXIOM_ROOT_GUARD_STATE_DIR = state;
			const scope = await resolveScopeDir(state, root);
			await appendGrant(scope, { id: "rg-1", prefixes: [other], reason: "approved" });
			const { pi, toolCall } = fakePi();
			createWorkspaceGuard({ root, cwd: root })(pi);
			expect(
				await toolCall({
					type: "tool_call",
					toolName: "edit",
					toolCallId: "11",
					input: { path: join(other, "x.ts"), edits: [] },
				}),
			).toBeUndefined();
			// grant-use escapes are audited, like the shell tools (ADR-0052)
			const audit = await listAudit(scope);
			expect(audit.some((e) => e.event === "grant-use" && (e as { tool?: string }).tool === "edit")).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.AXIOM_ROOT_GUARD_STATE_DIR;
			else process.env.AXIOM_ROOT_GUARD_STATE_DIR = prev;
			await rm(root, { recursive: true, force: true });
			await rm(other, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});
});

describe("workspace guard deny and block audit (ADR-0052)", () => {
	it("blocks an edit under a deny prefix even inside the root", async () => {
		const root = await makeRoot();
		try {
			await writeFile(join(root, "a.ts"), "x");
			const { pi, toolCall } = fakePi();
			createWorkspaceGuard({ root, cwd: root, denyPrefixes: [join(root, ".secrets")] })(pi);
			const res = fromAny<{ block: boolean; reason: string }, unknown>(
				await toolCall({
					type: "tool_call",
					toolName: "edit",
					toolCallId: "12",
					input: { path: join(root, ".secrets", "x.ts"), edits: [] },
				}),
			);
			expect(res.block).toBe(true);
			expect(res.reason).toMatch(/denied/i);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("deny beats an allow prefix for edits", async () => {
		const root = await makeRoot();
		const other = await makeRoot();
		try {
			const { pi, toolCall } = fakePi();
			createWorkspaceGuard({ root, cwd: root, allowPrefixes: [other], denyPrefixes: [other] })(pi);
			const res = fromAny<{ block: boolean }, unknown>(
				await toolCall({
					type: "tool_call",
					toolName: "edit",
					toolCallId: "13",
					input: { path: join(other, "x.ts"), edits: [] },
				}),
			);
			expect(res.block).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(other, { recursive: true, force: true });
		}
	});

	it("audits an edit block", async () => {
		const root = await makeRoot();
		const other = await makeRoot();
		const state = await makeRoot();
		const prev = process.env.AXIOM_ROOT_GUARD_STATE_DIR;
		try {
			process.env.AXIOM_ROOT_GUARD_STATE_DIR = state;
			const scope = await resolveScopeDir(state, root);
			const { pi, toolCall } = fakePi();
			createWorkspaceGuard({ root, cwd: root })(pi);
			await toolCall({
				type: "tool_call",
				toolName: "edit",
				toolCallId: "14",
				input: { path: join(other, "x.ts"), edits: [] },
			});
			const audit = await listAudit(scope);
			expect(audit.some((e) => e.event === "block" && (e as { tool?: string }).tool === "edit")).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.AXIOM_ROOT_GUARD_STATE_DIR;
			else process.env.AXIOM_ROOT_GUARD_STATE_DIR = prev;
			await rm(root, { recursive: true, force: true });
			await rm(other, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});
});
