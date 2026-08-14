import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleRootGuardCommand } from "../../src/cli/root-guard-command.js";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.js";
import {
	appendGrant,
	listAudit,
	listGrantPrefixes,
	resolveScopeDir,
	writeDecision,
} from "../../src/core/root-guard/store.js";
import { createRootGuard, INFRA_ALLOW_PREFIXES } from "../../src/extensions/root-guard/index.js";

const HOME = "/home/alice";
const GUARD_ENV = [
	"AXIOM_PROJECT_ROOT",
	"AXIOM_ROOT_GUARD_ALLOW",
	"AXIOM_ROOT_GUARD_DENY",
	"AXIOM_ROOT_GUARD_STATE_DIR",
	"AXIOM_ROOT_GUARD_APPROVAL_TIMEOUT_MS",
] as const;

function scrubEnv(): void {
	for (const key of GUARD_ENV) delete process.env[key];
}

beforeAll(scrubEnv);
afterAll(scrubEnv);

interface FakePi {
	pi: ExtensionAPI;
	toolCall: (event: Record<string, unknown>) => Promise<unknown>;
	tools: Map<string, ToolDefinition>;
}

function fakePi(): FakePi {
	const handlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
	const tools = new Map<string, ToolDefinition>();
	return {
		pi: fromAny<ExtensionAPI, unknown>({
			on: (evt: string, h: (...a: unknown[]) => unknown) => handlers.set(evt, [...(handlers.get(evt) ?? []), h]),
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		}),
		toolCall: async (event) => {
			let result: unknown;
			for (const h of handlers.get("tool_call") ?? []) {
				result = await h(event, undefined);
				if (result && fromPartial<{ block?: boolean }>(result).block) break;
			}
			return result;
		},
		tools,
	};
}

async function makeRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "axiom-rgx-"));
}

function bashEvent(input: { command: string }): Record<string, unknown> {
	return { type: "tool_call", toolName: "bash", toolCallId: "b1", input };
}

function ipyEvent(input: { code: string }): Record<string, unknown> {
	return { type: "tool_call", toolName: "ipython", toolCallId: "i1", input };
}

async function approvalTool(fake: FakePi) {
	const tool = fake.tools.get("request_root_access");
	expect(tool).toBeDefined();
	return tool as ToolDefinition;
}

async function pendingNames(scope: string): Promise<string[]> {
	try {
		return await readdir(join(scope, "pending"));
	} catch {
		return [];
	}
}

async function runTool(tool: ToolDefinition, params: unknown, signal?: AbortSignal) {
	return tool.execute("t1", params as never, signal, undefined, fromPartial({}));
}

function textOf(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
	const content = result.content as Array<{ type: string; text?: string }>;
	return content.map((c) => c.text ?? "").join("\n");
}

describe("root guard extension (tool_call gate)", () => {
	it("is inert without a project root: no handlers, no tool", () => {
		const fake = fakePi();
		createRootGuard()(fake.pi);
		expect(fake.tools.size).toBe(0);
	});

	it("registers request_root_access only when anchored", () => {
		const anchored = fakePi();
		createRootGuard({ root: "/work/p", stateDir: "/tmp/x" })(anchored.pi);
		expect(anchored.tools.has("request_root_access")).toBe(true);
	});

	it("blocks a bash call that touches home data", async () => {
		const root = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: await makeRoot(), home: HOME })(fake.pi);
			const res = fromAny<{ block: boolean; reason: string }, unknown>(
				await fake.toolCall(bashEvent({ command: "cat ~/Documents/notes.txt" })),
			);
			expect(res.block).toBe(true);
			expect(res.reason).toContain(HOME);
			expect(res.reason).toMatch(/request_root_access/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("blocks an ipython cell that writes outside the root", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME })(fake.pi);
			const res = fromAny<{ block: boolean }, unknown>(
				await fake.toolCall(ipyEvent({ code: "%%bash\ncat /mnt/backup/x" })),
			);
			expect(res.block).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("blocks outside paths by default — strict posture (issue #17 criterion a)", async () => {
		const root = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: await makeRoot(), home: HOME })(fake.pi);
			const res = fromAny<{ block: boolean }, unknown>(
				await fake.toolCall(bashEvent({ command: "cat /etc/os-release" })),
			);
			expect(res.block).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("the infra list is opt-in via allow prefixes", async () => {
		const root = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({
				root,
				cwd: root,
				stateDir: await makeRoot(),
				home: HOME,
				allowPrefixes: INFRA_ALLOW_PREFIXES(HOME, `${HOME}/.axiom`),
			})(fake.pi);
			expect(await fake.toolCall(bashEvent({ command: "cat /etc/os-release" }))).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("honors allow and deny options (deny wins)", async () => {
		const root = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({
				root,
				cwd: root,
				stateDir: await makeRoot(),
				home: HOME,
				allowPrefixes: ["/mnt"],
				denyPrefixes: ["/tmp"],
			})(fake.pi);
			expect(await fake.toolCall(bashEvent({ command: "cat /mnt/backup/x" }))).toBeUndefined();
			const res = fromAny<{ block: boolean }, unknown>(await fake.toolCall(bashEvent({ command: "cat /tmp/x" })));
			expect(res.block).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("lets an operator-approved grant unblock a path and audits the use", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const scope = await resolveScopeDir(state, root);
			await appendGrant(scope, { id: "rg-1", prefixes: ["/mnt"], reason: "backup" });
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME })(fake.pi);
			expect(await fake.toolCall(bashEvent({ command: "cat /mnt/backup/x" }))).toBeUndefined();
			const audit = await listAudit(scope);
			expect(audit.some((e) => e.event === "grant-use" && (e as { tool?: string }).tool === "bash")).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("audits blocks and leaves edit to the workspace guard", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const scope = await resolveScopeDir(state, root);
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME })(fake.pi);
			await fake.toolCall(bashEvent({ command: "cat ~/Documents/x" }));
			const audit = await listAudit(scope);
			expect(audit.some((e) => e.event === "block" && (e as { tool?: string }).tool === "bash")).toBe(true);
			expect(
				await fake.toolCall({
					type: "tool_call",
					toolName: "edit",
					toolCallId: "e1",
					input: { path: "../x.ts", edits: [] },
				}),
			).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("reads AXIOM_ROOT_GUARD_DENY from the environment", async () => {
		const root = await makeRoot();
		const prev = process.env.AXIOM_PROJECT_ROOT;
		const prevDeny = process.env.AXIOM_ROOT_GUARD_DENY;
		try {
			process.env.AXIOM_PROJECT_ROOT = root;
			process.env.AXIOM_ROOT_GUARD_DENY = "/tmp";
			const fake = fakePi();
			createRootGuard({ stateDir: await makeRoot(), home: HOME })(fake.pi);
			expect(await fake.toolCall(bashEvent({ command: "cat /tmp/x" }))).toMatchObject({ block: true });
		} finally {
			if (prev === undefined) delete process.env.AXIOM_PROJECT_ROOT;
			else process.env.AXIOM_PROJECT_ROOT = prev;
			if (prevDeny === undefined) delete process.env.AXIOM_ROOT_GUARD_DENY;
			else process.env.AXIOM_ROOT_GUARD_DENY = prevDeny;
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed with a plain reason when the approval store is unusable", async () => {
		const root = await makeRoot();
		const state = join(await makeRoot(), "not-a-dir");
		await writeFile(state, "x");
		try {
			const fake = fakePi();
			// stateDir is a FILE, so the store cannot be created under it
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME })(fake.pi);
			const res = fromAny<{ block: boolean; reason: string }, unknown>(
				await fake.toolCall(bashEvent({ command: "cat /srv/data" })),
			);
			expect(res.block).toBe(true);
			expect(res.reason).toMatch(/store/i);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("does not consult the store for calls the static policy allows", async () => {
		const root = await makeRoot();
		const state = join(await makeRoot(), "not-a-dir");
		await writeFile(state, "x");
		try {
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME, allowPrefixes: ["/tmp"] })(fake.pi);
			// allowed by policy -> no store consult -> no store failure (NIT-4)
			expect(await fake.toolCall(bashEvent({ command: "cat /tmp/x" }))).toBeUndefined();
			expect(await fake.toolCall(bashEvent({ command: "cat src/a.ts" }))).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("anchors from AXIOM_PROJECT_ROOT and reads AXIOM_ROOT_GUARD_ALLOW", async () => {
		const root = await makeRoot();
		const prev = process.env.AXIOM_PROJECT_ROOT;
		const prevAllow = process.env.AXIOM_ROOT_GUARD_ALLOW;
		try {
			process.env.AXIOM_PROJECT_ROOT = root;
			process.env.AXIOM_ROOT_GUARD_ALLOW = "/mnt";
			const fake = fakePi();
			createRootGuard({ stateDir: await makeRoot(), home: HOME })(fake.pi);
			expect(await fake.toolCall(bashEvent({ command: "cat /mnt/backup/x" }))).toBeUndefined();
			expect(await fake.toolCall(bashEvent({ command: "cat /srv/data/x" }))).toMatchObject({ block: true });
		} finally {
			if (prev === undefined) delete process.env.AXIOM_PROJECT_ROOT;
			else process.env.AXIOM_PROJECT_ROOT = prev;
			if (prevAllow === undefined) delete process.env.AXIOM_ROOT_GUARD_ALLOW;
			else process.env.AXIOM_ROOT_GUARD_ALLOW = prevAllow;
			await rm(root, { recursive: true, force: true });
		}
	});

	it("ships the opt-in infra allowlist (never applied automatically)", () => {
		const allow = INFRA_ALLOW_PREFIXES(HOME, join(HOME, ".axiom"));
		expect(allow).toContain("/etc");
		expect(allow).toContain("/tmp");
		expect(allow).toContain(join(HOME, ".axiom"));
		expect(allow).toContain(join(HOME, ".local"));
		expect(allow).not.toContain(join(HOME, "Documents"));
		expect(allow).not.toContain(HOME);
	});
});

describe("default state layout (single root-guard segment)", () => {
	it("lays state out as <axiom home>/root-guard/<rootHash>/", async () => {
		const root = await makeRoot();
		const home = await makeRoot();
		const prevHome = process.env.AXIOM_HOME;
		try {
			process.env.AXIOM_HOME = home;
			const fake = fakePi();
			createRootGuard({ root, cwd: root, home: HOME, approvalTimeoutMs: 5, pollMs: 5 })(fake.pi);
			const tool = await approvalTool(fake);
			const result = await runTool(tool, { paths: ["/srv/data"], reason: "layout" });
			expect(textOf(result)).toMatch(/pending/i);
			const hashDirs = await readdir(join(home, "root-guard"));
			expect(hashDirs).toHaveLength(1);
			const single = await pendingNames(join(home, "root-guard", hashDirs[0]));
			expect(single).toHaveLength(1);
		} finally {
			if (prevHome === undefined) delete process.env.AXIOM_HOME;
			else process.env.AXIOM_HOME = prevHome;
			await rm(root, { recursive: true, force: true });
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("request_root_access tool (approval loop)", () => {
	it("rejects requests whose paths are already inside the root", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME })(fake.pi);
			const tool = await approvalTool(fake);
			const result = await runTool(tool, { paths: ["src/a.ts"], reason: "need it" });
			expect(textOf(result)).toMatch(/inside/i);
			const scope = await resolveScopeDir(state, root);
			expect(await pendingNames(scope)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("times out into a pending message with the request id, without a grant", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME, approvalTimeoutMs: 5, pollMs: 5 })(fake.pi);
			const tool = await approvalTool(fake);
			const result = await runTool(tool, { paths: ["/srv/data"], reason: "need data" });
			const text = textOf(result);
			expect(text).toMatch(/pending/i);
			expect(text).toMatch(/rg-[0-9a-z]+-[0-9a-f]{4}/);
			// the relayed commands must work from the operator's terminal (NEW7)
			expect(text).toContain(`--root '${root}'`);
			expect(text).toContain(`--state-dir '${state}'`);
			expect(text).toMatch(/reject .*--root/);
			const scope = await resolveScopeDir(state, root);
			expect(await listGrantPrefixes(scope)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("reads AXIOM_ROOT_GUARD_APPROVAL_TIMEOUT_MS from the environment", async () => {
		const root = await makeRoot();
		const prevRoot = process.env.AXIOM_PROJECT_ROOT;
		const prevTimeout = process.env.AXIOM_ROOT_GUARD_APPROVAL_TIMEOUT_MS;
		try {
			process.env.AXIOM_PROJECT_ROOT = root;
			process.env.AXIOM_ROOT_GUARD_APPROVAL_TIMEOUT_MS = "5";
			const fake = fakePi();
			createRootGuard({ stateDir: await makeRoot(), home: HOME, pollMs: 5 })(fake.pi);
			const tool = await approvalTool(fake);
			const result = await runTool(tool, { paths: ["/srv/data"], reason: "need data" });
			expect(textOf(result)).toMatch(/pending/i);
		} finally {
			if (prevRoot === undefined) delete process.env.AXIOM_PROJECT_ROOT;
			else process.env.AXIOM_PROJECT_ROOT = prevRoot;
			if (prevTimeout === undefined) delete process.env.AXIOM_ROOT_GUARD_APPROVAL_TIMEOUT_MS;
			else process.env.AXIOM_ROOT_GUARD_APPROVAL_TIMEOUT_MS = prevTimeout;
			await rm(root, { recursive: true, force: true });
		}
	});

	it("records exactly one grant line when the CLI approves while the wait runs", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const scope = await resolveScopeDir(state, root);
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME, approvalTimeoutMs: 5000, pollMs: 10 })(
				fake.pi,
			);
			const tool = await approvalTool(fake);
			const running = runTool(tool, { paths: ["/srv/data"], reason: "need data" });
			let id = "";
			for (let i = 0; i < 200; i++) {
				const names = await pendingNames(scope);
				if (names.length > 0) {
					id = names[0].replace(/\.json$/, "");
					const logs: string[] = [];
					const prevLog = console.log;
					console.log = (line: string) => logs.push(line);
					await handleRootGuardCommand(["root-guard", "approve", id, "--root", root, "--state-dir", state]);
					console.log = prevLog;
					break;
				}
				await new Promise((r) => setTimeout(r, 10));
			}
			const text = textOf(await running);
			expect(text).toMatch(/approved/i);
			expect(await listGrantPrefixes(scope)).toEqual(["/srv/data"]);
			const grantsRaw = await readFile(join(scope, "grants.jsonl"), "utf8");
			expect(grantsRaw.trim().split("\n")).toHaveLength(1);
			const audit = await listAudit(scope);
			expect(audit.filter((e) => e.event === "grant")).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("returns approved when the operator decides while the wait runs, and records the grant", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const scope = await resolveScopeDir(state, root);
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME, approvalTimeoutMs: 5000, pollMs: 10 })(
				fake.pi,
			);
			const tool = await approvalTool(fake);
			const running = runTool(tool, { paths: ["/srv/data"], reason: "need data" });
			// approve as soon as the request file exists
			for (let i = 0; i < 200; i++) {
				const names = await pendingNames(scope);
				if (names.length > 0) {
					const id = names[0].replace(/\.json$/, "");
					await writeDecision(scope, id, { approved: true, note: "ok" });
					break;
				}
				await new Promise((r) => setTimeout(r, 10));
			}
			const text = textOf(await running);
			expect(text).toMatch(/approved/i);
			expect(await listGrantPrefixes(scope)).toEqual(["/srv/data"]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("returns rejected when the operator denies, without a grant", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const scope = await resolveScopeDir(state, root);
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME, approvalTimeoutMs: 5000, pollMs: 10 })(
				fake.pi,
			);
			const tool = await approvalTool(fake);
			const running = runTool(tool, { paths: ["/srv/data"], reason: "need data" });
			for (let i = 0; i < 200; i++) {
				const names = await pendingNames(scope);
				if (names.length > 0) {
					await writeDecision(scope, names[0].replace(/\.json$/, ""), { approved: false });
					break;
				}
				await new Promise((r) => setTimeout(r, 10));
			}
			const text = textOf(await running);
			expect(text).toMatch(/rejected/i);
			expect(await listGrantPrefixes(scope)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("stops waiting when the run signal aborts, still pending", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME, approvalTimeoutMs: 60000, pollMs: 20 })(
				fake.pi,
			);
			const tool = await approvalTool(fake);
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 40);
			const text = textOf(await runTool(tool, { paths: ["/srv/data"], reason: "need data" }, controller.signal));
			expect(text).toMatch(/pending/i);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});
});

describe("root guard freeform resolution and deny interplay", () => {
	it("resolves relative tokens against the project root, not process.cwd()", async () => {
		const root = await makeRoot();
		try {
			const fake = fakePi();
			// cwd deliberately omitted: the kernel may have cd'd anywhere; the root is the invariant
			createRootGuard({ root, stateDir: await makeRoot(), home: HOME })(fake.pi);
			const res = fromAny<{ block: boolean }, unknown>(
				await fake.toolCall(ipyEvent({ code: "open('../../outside.txt')" })),
			);
			expect(res.block).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("refuses to file a request for paths the operator already denied", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME, denyPrefixes: ["/srv"] })(fake.pi);
			const tool = await approvalTool(fake);
			const result = await runTool(tool, { paths: ["/srv/data"], reason: "need data" });
			expect(textOf(result)).toMatch(/permanently denied/i);
			const scope = await resolveScopeDir(state, root);
			expect(await pendingNames(scope)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("filters denied paths out of a mixed request and files the rest", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({
				root,
				cwd: root,
				stateDir: state,
				home: HOME,
				denyPrefixes: ["/srv"],
				approvalTimeoutMs: 5,
				pollMs: 5,
			})(fake.pi);
			const tool = await approvalTool(fake);
			const result = await runTool(tool, { paths: ["/srv/data", "/mnt/x"], reason: "mixed" });
			const text = textOf(result);
			expect(text).toMatch(/pending/i);
			expect(text).toMatch(/\/mnt\/x/);
			// the dropped denied path is named, not silently vanished (NEW2)
			expect(text).toMatch(/permanently denied/);
			expect(text).toMatch(/\/srv\/data/);
			const scope = await resolveScopeDir(state, root);
			const names = await pendingNames(scope);
			expect(names).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});
});

describe("request tool deny handling and curated store failures (round 4)", () => {
	it("reports permanent denial for a denied path INSIDE the root", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME, denyPrefixes: [`${root}/.secrets`] })(fake.pi);
			const tool = await approvalTool(fake);
			const result = await runTool(tool, { paths: [`${root}/.secrets/k.txt`], reason: "need it" });
			expect(textOf(result)).toMatch(/permanently denied/i);
			expect(textOf(result)).toContain(`${root}/.secrets/k.txt`);
			const scope = await resolveScopeDir(state, root);
			expect(await pendingNames(scope)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("returns a plain message when filing the request fails after the scope resolved", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		const scope = await resolveScopeDir(state, root);
		try {
			await chmod(scope, 0o555);
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME })(fake.pi);
			const tool = await approvalTool(fake);
			const result = await runTool(tool, { paths: ["/srv/data"], reason: "need data" });
			expect(textOf(result)).toMatch(/store failed/i);
		} finally {
			await chmod(scope, 0o755);
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});
});

describe("rejected mixed request names the dropped denied paths (round 7 MINOR-1)", () => {
	it("appends the denial note to the rejected outcome", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const scope = await resolveScopeDir(state, root);
			const fake = fakePi();
			createRootGuard({
				root,
				cwd: root,
				stateDir: state,
				home: HOME,
				denyPrefixes: ["/srv"],
				approvalTimeoutMs: 5000,
				pollMs: 10,
			})(fake.pi);
			const tool = await approvalTool(fake);
			const running = runTool(tool, { paths: ["/srv/data", "/mnt/x"], reason: "mixed" });
			for (let i = 0; i < 200; i++) {
				const names = await pendingNames(scope);
				if (names.length > 0) {
					await writeDecision(scope, names[0].replace(/\.json$/, ""), { approved: false });
					break;
				}
				await new Promise((r) => setTimeout(r, 10));
			}
			const text = textOf(await running);
			expect(text).toMatch(/rejected/i);
			expect(text).toMatch(/permanently denied/);
			expect(text).toMatch(/\/srv\/data/);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});
});
