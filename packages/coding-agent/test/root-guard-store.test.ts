import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendAudit,
	appendGrant,
	fileRequest,
	listAudit,
	listDecisions,
	listGrantPrefixes,
	listPending,
	readDecision,
	readPending,
	resolveScopeDir,
	writeDecision,
} from "../src/core/root-guard/store.js";

async function makeState(): Promise<string> {
	return mkdtemp(join(tmpdir(), "axiom-rg-"));
}

describe("root guard store (file-backed approval state)", () => {
	it("scopes state by root hash and is stable across calls", async () => {
		const state = await makeState();
		try {
			const a = await resolveScopeDir(state, "/work/proj-a");
			const b = await resolveScopeDir(state, "/work/proj-b");
			const a2 = await resolveScopeDir(state, "/work/proj-a");
			expect(a).not.toBe(b);
			expect(a).toBe(a2);
			expect(a).toContain("root-guard");
			expect(a).toContain(join(state, "root-guard"));
		} finally {
			await rm(state, { recursive: true, force: true });
		}
	});

	it("files a pending request and reads it back", async () => {
		const state = await makeState();
		try {
			const scope = await resolveScopeDir(state, "/work/p");
			const { id } = await fileRequest(scope, { paths: ["/etc/passwd"], reason: "need to read it" });
			expect(id).toMatch(/^rg-[0-9a-z]+-[0-9a-f]{4}$/);
			const rec = await readPending(scope, id);
			expect(rec).toMatchObject({ id, paths: ["/etc/passwd"], reason: "need to read it", status: "pending" });
		} finally {
			await rm(state, { recursive: true, force: true });
		}
	});

	it("lists pending requests oldest first", async () => {
		const state = await makeState();
		try {
			const scope = await resolveScopeDir(state, "/work/p");
			await fileRequest(scope, { paths: ["/a"], reason: "one", id: "rg-1" });
			await fileRequest(scope, { paths: ["/b"], reason: "two", id: "rg-2" });
			const pending = await listPending(scope);
			expect(pending.map((p) => p.id)).toEqual(["rg-1", "rg-2"]);
		} finally {
			await rm(state, { recursive: true, force: true });
		}
	});

	it("writes and reads a decision, newest first in lists", async () => {
		const state = await makeState();
		try {
			const scope = await resolveScopeDir(state, "/work/p");
			await fileRequest(scope, { paths: ["/a"], reason: "one", id: "rg-1" });
			await fileRequest(scope, { paths: ["/b"], reason: "two", id: "rg-2" });
			await writeDecision(scope, "rg-1", { approved: true, note: "fine" });
			await writeDecision(scope, "rg-2", { approved: false });
			expect(await readDecision(scope, "rg-1")).toMatchObject({ approved: true, note: "fine" });
			const decisions = await listDecisions(scope);
			expect(decisions.length).toBe(2);
			expect(decisions[0].id).toBe("rg-2");
		} finally {
			await rm(state, { recursive: true, force: true });
		}
	});

	it("appends grants and returns their prefixes", async () => {
		const state = await makeState();
		try {
			const scope = await resolveScopeDir(state, "/work/p");
			await appendGrant(scope, { id: "rg-1", prefixes: ["/etc"], reason: "read hosts" });
			await appendGrant(scope, { id: "rg-2", prefixes: ["/tmp/scratch", "/var/log"], reason: "logs" });
			expect((await listGrantPrefixes(scope)).sort()).toEqual(["/etc", "/tmp/scratch", "/var/log"]);
		} finally {
			await rm(state, { recursive: true, force: true });
		}
	});

	it("appends audit events as JSONL, newest first when listed", async () => {
		const state = await makeState();
		try {
			const scope = await resolveScopeDir(state, "/work/p");
			await appendAudit(scope, { event: "block", tool: "bash", paths: ["/etc/passwd"] });
			await appendAudit(scope, { event: "decision", id: "rg-1", approved: true });
			const audit = await listAudit(scope);
			expect(audit.length).toBe(2);
			expect(audit[0]).toMatchObject({ event: "decision", id: "rg-1" });
			expect(audit[1]).toMatchObject({ event: "block", tool: "bash" });
			const raw = await readFile(join(scope, "audit.jsonl"), "utf8");
			expect(raw.trim().split("\n")).toHaveLength(2);
		} finally {
			await rm(state, { recursive: true, force: true });
		}
	});

	it("keeps a missing pending/decision read quiet (undefined)", async () => {
		const state = await makeState();
		try {
			const scope = await resolveScopeDir(state, "/work/p");
			expect(await readPending(scope, "rg-nope")).toBeUndefined();
			expect(await readDecision(scope, "rg-nope")).toBeUndefined();
		} finally {
			await rm(state, { recursive: true, force: true });
		}
	});
});
