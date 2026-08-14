/**
 * Root guard attack corpus (ADR-0052 hardening, 2026-08-14).
 *
 * Permanent regression tests distilled from the adversarial red-team report
 * (root-guard-redteam.md, blockers B1-B7). Every case is an exact input from
 * the report plus its expected verdict. Cases that were real holes FAILED
 * against the pre-hardening code (red-first evidence captured in
 * root-guard-hardening-report.md); they are green only after the hardening.
 *
 * Rows are grouped by blocker family. "block" means the tool_call handler
 * returns { block: true } (or decideEdit blocks); "allow" means undefined.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.js";
import {
	appendGrant,
	fileRequest,
	listGrantPrefixes,
	readDecision,
	resolveScopeDir,
} from "../../src/core/root-guard/store.js";
import { createRootGuard } from "../../src/extensions/root-guard/index.js";
import { decideEdit } from "../../src/extensions/workspace/guard.js";

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
	return mkdtemp(join(tmpdir(), "axiom-rgc-"));
}

function bashEvent(input: { command: string }): Record<string, unknown> {
	return { type: "tool_call", toolName: "bash", toolCallId: "c1", input };
}

function ipyEvent(input: { code: string }): Record<string, unknown> {
	return { type: "tool_call", toolName: "ipython", toolCallId: "c2", input };
}

interface CorpusCase {
	id: string;
	tool: "bash" | "ipython";
	input: string;
	expect: "block" | "allow";
	family: string;
}

/**
 * The corpus. Exact inputs from the red-team report (F1/F2 tables, python
 * escapes, the B1 self-approval chain, the B5 symlink chain) plus the
 * documented positive controls that must stay allowed.
 */
const CORPUS: readonly CorpusCase[] = [
	// ---- B2 / F1: slash-obfuscation family (red-team table 1) ----
	{ id: "F1-1", tool: "bash", input: String.raw`cat \/etc\/passwd`, expect: "block", family: "B2" },
	{ id: "F1-2", tool: "bash", input: String.raw`echo hi > \/etc\/motd`, expect: "block", family: "B2" },
	{ id: "F1-3", tool: "bash", input: String.raw`. \/etc\/profile`, expect: "block", family: "B2" },
	{ id: "F1-4", tool: "bash", input: String.raw`eval \cat\ \/etc\/passwd`, expect: "block", family: "B2" },
	{
		id: "F1-5",
		tool: "ipython",
		input: String.raw`%%bash
cat \/etc\/passwd`,
		expect: "block",
		family: "B2",
	},
	{ id: "F1-6", tool: "bash", input: String.raw`cat $'\x2fetc\x2fpasswd'`, expect: "block", family: "B2" },
	{ id: "F1-7", tool: "bash", input: String.raw`cat $(printf '\x2fetc\x2fpasswd')`, expect: "block", family: "B2" },
	{ id: "F1-8", tool: "bash", input: String.raw`cat $(echo -e '\057etc\057passwd')`, expect: "block", family: "B2" },
	{ id: "F1-9", tool: "bash", input: String.raw`cat $($'echo' $'\x2fetc\x2fpasswd')`, expect: "block", family: "B2" },
	{
		id: "F1-10",
		tool: "bash",
		input: String.raw`cd "$(printf '\x2fetc')" && head -1 passwd`,
		expect: "block",
		family: "B2",
	},
	{ id: "F1-11", tool: "bash", input: `curl file:///etc/passwd`, expect: "block", family: "B6" },

	// ---- B3 / F2: destructive bare-root with a trailing operand ----
	{ id: "F2-1", tool: "bash", input: `rm -rf / x`, expect: "block", family: "B3" },
	{ id: "F2-2", tool: "bash", input: `rm -rf --no-preserve-root / x`, expect: "block", family: "B3" },
	{ id: "F2-3", tool: "bash", input: `rm -rf --no-preserve-root /$(echo x)`, expect: "block", family: "B3" },
	{ id: "F2-4", tool: "bash", input: `chmod -R 777 / x`, expect: "block", family: "B3" },
	{ id: "F2-5", tool: "bash", input: `chown -R alice / x`, expect: "block", family: "B3" },
	{ id: "F2-6", tool: "bash", input: `cp -r / x`, expect: "block", family: "B3" },
	{ id: "F2-7", tool: "bash", input: `find / x`, expect: "block", family: "B3" },
	{ id: "F2-8", tool: "bash", input: `shred -f -z / x`, expect: "block", family: "B3" },
	{ id: "F2-9", tool: "bash", input: `dd of=/ if=./x`, expect: "block", family: "B3" },
	{ id: "F2-10", tool: "bash", input: `mv / x`, expect: "block", family: "B3" },
	{ id: "F2-11", tool: "bash", input: `chroot / ls`, expect: "block", family: "B3" },
	{
		id: "F2-12",
		tool: "ipython",
		input: `%%bash
rm -rf --no-preserve-root / x`,
		expect: "block",
		family: "B3",
	},
	// documented residual: `cat "/ x"` reads a file literally named "/ x"
	// inside the working directory (report marks it minor) — allowed.
	{ id: "F2-13", tool: "bash", input: `cat "/ x"`, expect: "allow", family: "B3" },

	// ---- python escapes through the ipython seam (red-team table 3) ----
	{ id: "PY-1", tool: "ipython", input: `open(chr(47) + 'etc' + chr(47) + 'passwd')`, expect: "block", family: "B2" },
	{
		id: "PY-2",
		tool: "ipython",
		input: `Path.home().joinpath('.ssh/id_rsa').read_text()`,
		expect: "block",
		family: "B2",
	},
	{ id: "PY-3", tool: "ipython", input: `os.chdir(os.environ['HOME'])`, expect: "block", family: "B1" },
	{ id: "PY-4", tool: "ipython", input: `%cd $HOME/.axiom`, expect: "block", family: "B1" },
	{ id: "PY-5", tool: "ipython", input: `%cd /home/mustbearn/.axiom`, expect: "block", family: "B1" },
	// division exemption must survive (report: ipython-only trade-off)
	{ id: "PY-6", tool: "ipython", input: `x = a / b`, expect: "allow", family: "B3" },
	{ id: "PY-7", tool: "ipython", input: `x = a / 2`, expect: "allow", family: "B3" },
	// env introspection without a path context stays allowed
	{ id: "PY-8", tool: "ipython", input: `print(os.environ)`, expect: "allow", family: "B2" },

	// ---- B1: the self-approval chain (exact 3 steps from the report) ----
	{
		id: "B1-1",
		tool: "ipython",
		input: `%cd $HOME/.axiom`,
		expect: "block",
		family: "B1",
	},
	{
		id: "B1-2",
		tool: "ipython",
		input:
			`open('root-guard/abc123def456/grants.jsonl','a').write(` +
			`json.dumps({'id':'rg-forged-1','prefixes':[chr(47)+'etc'],'reason':'forged','grantedAt':1}))`,
		expect: "block",
		family: "B1",
	},
	// step 3 without a valid signed grant must stay blocked
	{ id: "B1-3", tool: "bash", input: `cat /etc/passwd`, expect: "block", family: "B1" },

	// ---- B5: symlink target construction (closed by the B2 posture flip) ----
	{ id: "SYM-1", tool: "bash", input: `ln -s "$(printf '\\x2fetc')" link`, expect: "block", family: "B5" },
	{ id: "SYM-2", tool: "bash", input: `ln -s $HOME/.ssh sshlink`, expect: "block", family: "B5" },

	// ---- $ gap: variable-prefixed paths now fail closed ----
	{ id: "GAP-1", tool: "bash", input: `cat $HOME/.ssh/id_rsa`, expect: "block", family: "B2" },
	{ id: "GAP-2", tool: "bash", input: `cd $HOME && cat .ssh/id_rsa`, expect: "block", family: "B1" },

	// ---- positive controls that must stay allowed ----
	{ id: "OK-1", tool: "bash", input: `node scripts/query.mjs --json stats`, expect: "allow", family: "control" },
	{ id: "OK-2", tool: "bash", input: `cat src/core/root-guard/paths.ts`, expect: "allow", family: "control" },
	{ id: "OK-3", tool: "bash", input: `echo hi`, expect: "allow", family: "control" },
	{ id: "OK-4", tool: "bash", input: `rm -rf dist`, expect: "allow", family: "control" },
	{ id: "OK-5", tool: "bash", input: `ls src/`, expect: "allow", family: "control" },
	{ id: "OK-6", tool: "bash", input: `find src -name "*.ts"`, expect: "allow", family: "control" },
	{ id: "OK-7", tool: "ipython", input: `%cd src`, expect: "allow", family: "control" },
	// `cat / b` — documented accepted trade-off (infix operand, cat not on
	// the destructive list): still allowed.
	{ id: "OK-8", tool: "bash", input: `cat / b`, expect: "allow", family: "control" },
];

describe("root guard attack corpus (red-team report)", () => {
	for (const c of CORPUS) {
		it(`${c.family}/${c.id} ${c.expect === "block" ? "BLOCKS" : "ALLOWS"}: ${c.input.slice(0, 60)}`, async () => {
			const root = await makeRoot();
			const state = await makeRoot();
			try {
				const fake = fakePi();
				createRootGuard({ root, cwd: root, stateDir: state, home: HOME })(fake.pi);
				const event = c.tool === "bash" ? bashEvent({ command: c.input }) : ipyEvent({ code: c.input });
				const res = await fake.toolCall(event);
				if (c.expect === "block") {
					expect(res).toBeDefined();
					expect(fromAny<{ block?: boolean }, unknown>(res).block).toBe(true);
				} else {
					expect(res).toBeUndefined();
				}
			} finally {
				await rm(root, { recursive: true, force: true });
				await rm(state, { recursive: true, force: true });
			}
		});
	}
});

describe("B1 self-approval: unsigned store entries are inert (signing)", () => {
	it("ignores a forged unsigned grant line (the red-team forge)", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const scope = await resolveScopeDir(state, root);
			// the exact forged shape from the report, appended raw:
			await appendFile(
				join(scope, "grants.jsonl"),
				`${JSON.stringify({ id: "rg-forged-1", prefixes: ["/etc"], reason: "forged", grantedAt: 1 })}\n`,
			);
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME })(fake.pi);
			const res = await fake.toolCall(bashEvent({ command: "cat /etc/passwd" }));
			expect(fromAny<{ block?: boolean }, unknown>(res).block).toBe(true);
			expect(await listGrantPrefixes(scope)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("ignores a tampered signed grant line (record mutated, sig stale)", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const scope = await resolveScopeDir(state, root);
			await appendGrant(scope, { id: "rg-1", prefixes: ["/mnt"], reason: "backup" });
			// tamper: widen the record but keep the original signature
			const raw = await readFile(join(scope, "grants.jsonl"), "utf8");
			const line = JSON.parse(raw.trim()) as { record: { prefixes: string[] }; sig: string };
			line.record.prefixes = ["/etc"];
			await writeFile(join(scope, "grants.jsonl"), `${JSON.stringify(line)}\n`);
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME })(fake.pi);
			expect(
				fromAny<{ block?: boolean }, unknown>(await fake.toolCall(bashEvent({ command: "cat /etc/passwd" }))).block,
			).toBe(true);
			expect(
				fromAny<{ block?: boolean }, unknown>(await fake.toolCall(bashEvent({ command: "cat /mnt/x" }))).block,
			).toBe(true);
			expect(await listGrantPrefixes(scope)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("honors a CLI-signed grant (positive control for the signing path)", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const scope = await resolveScopeDir(state, root);
			await appendGrant(scope, { id: "rg-1", prefixes: ["/mnt"], reason: "backup" });
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME })(fake.pi);
			expect(await fake.toolCall(bashEvent({ command: "cat /mnt/backup/x" }))).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("treats a forged unsigned decision file as absent (fail closed)", async () => {
		const state = await makeRoot();
		try {
			const scope = await resolveScopeDir(state, "/work/p");
			await fileRequest(scope, { paths: ["/etc"], reason: "x", id: "rg-1" });
			await mkdir(join(scope, "decisions"), { recursive: true });
			await writeFile(
				join(scope, "decisions", "rg-1.json"),
				JSON.stringify({ id: "rg-1", approved: true, decidedAt: Date.now() }),
			);
			expect(await readDecision(scope, "rg-1")).toBeUndefined();
		} finally {
			await rm(state, { recursive: true, force: true });
		}
	});

	it("never creates the signing key on the agent path (CLI owns the key)", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const scope = await resolveScopeDir(state, root);
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME })(fake.pi);
			await fake.toolCall(bashEvent({ command: "cat /etc/passwd" }));
			expect(existsSync(join(scope, ".hmac-key"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("hard-denies the state dir even when an allow prefix covers it", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME, allowPrefixes: [state] })(fake.pi);
			const res = await fake.toolCall(bashEvent({ command: `cat ${state}/root-guard/grants.jsonl` }));
			expect(fromAny<{ block?: boolean }, unknown>(res).block).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("hard-denies the legacy store location under the axiom home", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const realHome = homedir();
			const fake = fakePi();
			createRootGuard({
				root,
				cwd: root,
				stateDir: state,
				home: realHome,
				allowPrefixes: [join(realHome, ".axiom")],
			})(fake.pi);
			const res = await fake.toolCall(bashEvent({ command: `cat ~/.axiom/root-guard/grants.jsonl` }));
			expect(fromAny<{ block?: boolean }, unknown>(res).block).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});
});

describe("B4 edit-seam tilde escape", () => {
	it("blocks ~/Documents/note.md (the tool expands ~, so must the guard)", async () => {
		const root = await makeRoot();
		try {
			const res = await decideEdit(await realpathEditRoot(root), root, "~/Documents/note.md", { home: HOME });
			expect(res?.block).toBe(true);
			expect(res?.reason).toMatch(/outside/i);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("blocks ~/.ssh/id_rsa", async () => {
		const root = await makeRoot();
		try {
			const res = await decideEdit(await realpathEditRoot(root), root, "~/.ssh/id_rsa", { home: HOME });
			expect(res?.block).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("deny prefixes and the path use the same expansion (report case)", async () => {
		const root = await makeRoot();
		try {
			const res = await decideEdit(await realpathEditRoot(root), root, "~/Documents/note.md", {
				home: HOME,
				denyPrefixes: ["~/Documents"],
			});
			expect(res?.block).toBe(true);
			expect(res?.reason).toMatch(/denied/i);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps inside-root edits allowed (control)", async () => {
		const root = await makeRoot();
		try {
			await writeFile(join(root, "a.ts"), "x");
			const res = await decideEdit(await realpathEditRoot(root), root, "src/a.ts", { home: HOME });
			expect(res).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

/** realpath of the root, matching the workspace extension's normalization. */
async function realpathEditRoot(root: string): Promise<string> {
	const { realpathX } = await import("../../src/extensions/workspace/guard.js");
	return realpathX(root);
}

describe("B6 request breadth (over-broad requests never reach the board)", () => {
	async function approvalTool(fake: FakePi): Promise<ToolDefinition> {
		const tool = fake.tools.get("request_root_access");
		expect(tool).toBeDefined();
		return tool as ToolDefinition;
	}

	async function runTool(tool: ToolDefinition, params: unknown) {
		return tool.execute("t1", params as never, undefined, undefined, fromPartial({}));
	}

	function textOf(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
		const content = result.content as Array<{ type: string; text?: string }>;
		return content.map((c) => c.text ?? "").join("\n");
	}

	it("refuses to file a request for the filesystem root", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME, approvalTimeoutMs: 5, pollMs: 5 })(fake.pi);
			const tool = await approvalTool(fake);
			const text = textOf(await runTool(tool, { paths: ["/"], reason: "everything" }));
			expect(text).toMatch(/off-limits|operator/i);
			const scope = await resolveScopeDir(state, root);
			expect(await readdir(join(scope, "pending")).catch(() => [])).toHaveLength(0);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("refuses to file a request for the operator's home", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME, approvalTimeoutMs: 5, pollMs: 5 })(fake.pi);
			const tool = await approvalTool(fake);
			const text = textOf(await runTool(tool, { paths: [`${HOME}/Documents`], reason: "home data" }));
			expect(text).toMatch(/off-limits|operator/i);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("refuses to file a request for the axiom home", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		const prevHome = process.env.AXIOM_HOME;
		const fakeAxiom = await makeRoot();
		try {
			process.env.AXIOM_HOME = fakeAxiom;
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME, approvalTimeoutMs: 5, pollMs: 5 })(fake.pi);
			const tool = await approvalTool(fake);
			const text = textOf(await runTool(tool, { paths: [join(fakeAxiom, "grants")], reason: "axiom home" }));
			expect(text).toMatch(/off-limits|operator/i);
		} finally {
			if (prevHome === undefined) delete process.env.AXIOM_HOME;
			else process.env.AXIOM_HOME = prevHome;
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
			await rm(fakeAxiom, { recursive: true, force: true });
		}
	});

	it("files a normal outside request (positive control)", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const fake = fakePi();
			createRootGuard({ root, cwd: root, stateDir: state, home: HOME, approvalTimeoutMs: 5, pollMs: 5 })(fake.pi);
			const tool = await approvalTool(fake);
			const text = textOf(await runTool(tool, { paths: ["/srv/data"], reason: "need data" }));
			expect(text).toMatch(/pending/i);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});
});
