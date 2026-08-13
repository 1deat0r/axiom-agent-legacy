import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	handleMemoryConsolidationCommand,
	parseMemoryConsolidationArgs,
} from "../src/cli/memory-consolidation-command.js";
import {
	consolidationAuditPath,
	consolidationPendingDir,
	listPendingProposals,
	readAuditEvents,
	stagePendingProposal,
} from "../src/core/memory-consolidation/index.js";
import type { MemoryFact } from "../src/core/memory-consolidation/types.js";
import { loadHarnessState } from "../src/core/refinement/index.js";

let tempDir: string | undefined;
afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "axiom-mc-cli-"));
	return tempDir;
}

const fact = (): MemoryFact => ({
	title: "Sandbox known-fails",
	content: "The daemon/worker EXDEV suites are documented sandbox known-fails, never regressions.",
});

function stageOne(dir: string, sessionId = "sess-1") {
	return stagePendingProposal(
		consolidationPendingDir(dir),
		{ summary: "consolidated sandbox policy", rationale: "durable environment fact", facts: [fact()] },
		{ sessionId },
	);
}

async function run(args: string[], dir: string): Promise<string[]> {
	const lines: string[] = [];
	const handled = await handleMemoryConsolidationCommand(args, {
		consolidationDir: dir,
		harnessStateDir: join(dir, "harness"),
		write: (line) => lines.push(line),
	});
	return handled ? lines : [];
}

describe("parseMemoryConsolidationArgs", () => {
	it("parses each command and required id", () => {
		expect(parseMemoryConsolidationArgs(["pending"])).toMatchObject({ ok: true, options: { command: "pending" } });
		expect(parseMemoryConsolidationArgs(["show", "mc_1"])).toMatchObject({
			ok: true,
			options: { command: "show", id: "mc_1" },
		});
		expect(parseMemoryConsolidationArgs(["approve", "mc_1"])).toMatchObject({
			ok: true,
			options: { command: "approve", id: "mc_1" },
		});
		expect(parseMemoryConsolidationArgs(["reject", "mc_1"])).toMatchObject({
			ok: true,
			options: { command: "reject", id: "mc_1" },
		});
		expect(parseMemoryConsolidationArgs(["audit", "--limit", "5"])).toMatchObject({
			ok: true,
			options: { command: "audit", limit: 5 },
		});
	});

	it("rejects unknown commands and missing ids", () => {
		expect(parseMemoryConsolidationArgs(["frobnicate"])).toMatchObject({ ok: false });
		expect(parseMemoryConsolidationArgs([])).toMatchObject({ ok: false });
		expect(parseMemoryConsolidationArgs(["show"])).toMatchObject({ ok: false });
		expect(parseMemoryConsolidationArgs(["audit", "--limit", "zero"])).toMatchObject({ ok: false });
	});

	it("supports --help", () => {
		expect(parseMemoryConsolidationArgs(["--help"])).toMatchObject({ ok: false, help: true });
	});
});

describe("handleMemoryConsolidationCommand", () => {
	it("returns false for unrelated commands", async () => {
		expect(await run(["gateway"], makeTempDir())).toEqual([]);
	});

	it("lists no pending proposals when empty", async () => {
		const lines = await run(["memory-consolidation", "pending"], makeTempDir());
		expect(lines.join("\n")).toContain("No pending");
	});

	it("lists staged proposals", async () => {
		const dir = makeTempDir();
		const staged = stageOne(dir);
		const lines = await run(["memory-consolidation", "pending"], dir);
		expect(lines.join("\n")).toContain(staged.id);
		expect(lines.join("\n")).toContain("consolidated sandbox policy");
	});

	it("shows a proposal's summary, rationale, and facts", async () => {
		const dir = makeTempDir();
		const staged = stageOne(dir);
		const lines = await run(["memory-consolidation", "show", staged.id], dir);
		const text = lines.join("\n");
		expect(text).toContain("durable environment fact");
		expect(text).toContain("Sandbox known-fails");
		expect(text).toContain("documented sandbox known-fails");
	});

	it("errors on unknown proposal ids", async () => {
		const lines = await run(["memory-consolidation", "show", "mc_99999999999999999"], makeTempDir());
		expect(lines.join("\n")).toContain('unknown proposal "mc_99999999999999999"');
	});

	it("approves a proposal: applies to harness, resolves pending, and audits", async () => {
		const dir = makeTempDir();
		const staged = stageOne(dir);
		const lines = await run(["memory-consolidation", "approve", staged.id], dir);
		expect(lines.join("\n")).toContain("1 harness memory entry applied");
		expect(listPendingProposals(consolidationPendingDir(dir))).toHaveLength(0);
		const state = loadHarnessState(join(dir, "harness"));
		const entries = Object.values(state.entries.memory);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ source: "consolidate", title: "Sandbox known-fails" });
		expect(entries[0]?.metadata).toMatchObject({ proposalId: staged.id, sessionId: "sess-1" });
		const events = readAuditEvents(consolidationAuditPath(dir));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ action: "approved", accepted: 1, proposalId: staged.id });
	});

	it("approves a duplicate proposal honestly: nothing applied, pending resolved, audited", async () => {
		const dir = makeTempDir();
		// Pre-existing harness memory that duplicates the staged fact.
		await run(["memory-consolidation", "approve", stageOne(dir).id], dir);
		const staged = stageOne(dir);
		const lines = await run(["memory-consolidation", "approve", staged.id], dir);
		expect(lines.join("\n")).toContain("nothing new to apply");
		expect(listPendingProposals(consolidationPendingDir(dir))).toHaveLength(0);
		expect(readAuditEvents(consolidationAuditPath(dir))[0]).toMatchObject({ action: "approved", accepted: 0 });
	});

	it("rejects a proposal: resolved and audited", async () => {
		const dir = makeTempDir();
		const staged = stageOne(dir);
		const lines = await run(["memory-consolidation", "reject", staged.id], dir);
		expect(lines.join("\n")).toContain("discarded");
		expect(listPendingProposals(consolidationPendingDir(dir))).toHaveLength(0);
		expect(readAuditEvents(consolidationAuditPath(dir))[0]?.action).toBe("rejected");
	});

	it("shows the audit log newest-first", async () => {
		const dir = makeTempDir();
		const staged = stageOne(dir);
		await run(["memory-consolidation", "approve", staged.id], dir);
		const lines = await run(["memory-consolidation", "audit"], dir);
		expect(lines.join("\n")).toContain("approved");
	});

	it("prints help for --help", async () => {
		const lines = await run(["memory-consolidation", "--help"], makeTempDir());
		expect(lines.join("\n")).toContain("Usage:");
	});
});
