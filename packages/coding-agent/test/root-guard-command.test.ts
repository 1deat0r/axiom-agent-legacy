import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleRootGuardCommand } from "../src/cli/root-guard-command.js";
import { fileRequest, listDecisions, listGrantPrefixes, resolveScopeDir } from "../src/core/root-guard/store.js";

const GUARD_ENV = ["AXIOM_ROOT_GUARD_STATE_DIR", "AXIOM_PROJECT_ROOT"] as const;

function scrubEnv(): void {
	for (const key of GUARD_ENV) delete process.env[key];
}

beforeAll(scrubEnv);
afterAll(scrubEnv);

async function makeRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "axiom-rgc-"));
}

describe("axiom root-guard CLI", () => {
	it("returns false for other commands", async () => {
		expect(await handleRootGuardCommand(["peers"])).toBe(false);
	});

	it("prints help for --help", async () => {
		const logs: string[] = [];
		const prev = console.log;
		console.log = (s: string) => logs.push(s);
		try {
			expect(await handleRootGuardCommand(["root-guard", "--help"])).toBe(true);
		} finally {
			console.log = prev;
		}
		expect(logs.join("\n")).toMatch(/approve/);
	});

	it("lists an empty board as JSON when nothing is pending", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		const prev = process.env.AXIOM_ROOT_GUARD_STATE_DIR;
		try {
			process.env.AXIOM_ROOT_GUARD_STATE_DIR = state;
			const logs: string[] = [];
			const prevLog = console.log;
			console.log = (s: string) => logs.push(s);
			try {
				expect(await handleRootGuardCommand(["root-guard", "list", "--json", "--root", root])).toBe(true);
			} finally {
				console.log = prevLog;
			}
			const parsed = JSON.parse(logs.join("\n"));
			expect(parsed.pending).toEqual([]);
			expect(parsed.decisions).toEqual([]);
		} finally {
			if (prev === undefined) delete process.env.AXIOM_ROOT_GUARD_STATE_DIR;
			else process.env.AXIOM_ROOT_GUARD_STATE_DIR = prev;
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("approves a pending request and records the grant", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const scope = await resolveScopeDir(state, root);
			const { id } = await fileRequest(scope, { paths: ["/srv/data"], reason: "need data" });
			const logs: string[] = [];
			const prevLog = console.log;
			console.log = (s: string) => logs.push(s);
			try {
				expect(
					await handleRootGuardCommand(["root-guard", "approve", id, "--root", root, "--state-dir", state]),
				).toBe(true);
			} finally {
				console.log = prevLog;
			}
			expect(logs.join("\n")).toMatch(/approved/i);
			const decisions = await listDecisions(scope);
			expect(decisions).toHaveLength(1);
			expect(decisions[0]).toMatchObject({ id, approved: true });
			expect(await listGrantPrefixes(scope)).toEqual(["/srv/data"]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("rejects a pending request without a grant", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		try {
			const scope = await resolveScopeDir(state, root);
			const { id } = await fileRequest(scope, { paths: ["/srv/data"], reason: "need data" });
			expect(
				await handleRootGuardCommand([
					"root-guard",
					"reject",
					id,
					"--note",
					"no",
					"--root",
					root,
					"--state-dir",
					state,
				]),
			).toBe(true);
			const decisions = await listDecisions(scope);
			expect(decisions[0]).toMatchObject({ id, approved: false, note: "no" });
			expect(await listGrantPrefixes(scope)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});

	it("refuses to decide a request id that does not exist", async () => {
		const root = await makeRoot();
		const state = await makeRoot();
		const errors: string[] = [];
		const prevErr = console.error;
		console.error = (s: string) => errors.push(s);
		try {
			expect(
				await handleRootGuardCommand(["root-guard", "approve", "rg-nope", "--root", root, "--state-dir", state]),
			).toBe(true);
		} finally {
			console.error = prevErr;
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
		expect(errors.join("\n")).toMatch(/rg-nope/);
	});
});
