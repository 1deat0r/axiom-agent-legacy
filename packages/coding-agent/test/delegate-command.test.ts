import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDelegateCommand, resolveDelegateJournalTarget } from "../src/cli/delegate-command.js";

function writeJournal(dir: string, handle: string, records: unknown[]): string {
	const path = join(dir, `${handle}.journal.jsonl`);
	writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
	return path;
}

let dir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "delegate-cli-"));
	stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	rmSync(dir, { recursive: true, force: true });
});

function stdoutText(): string {
	return stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
}

describe("resolveDelegateJournalTarget", () => {
	it("maps a bare handle to resultsDir/<handle>.journal.jsonl", () => {
		expect(resolveDelegateJournalTarget("abc123", "/tmp/results")).toBe("/tmp/results/abc123.journal.jsonl");
	});

	it("passes a path through unchanged", () => {
		expect(resolveDelegateJournalTarget("/tmp/x/y.journal.jsonl", "/tmp/results")).toBe("/tmp/x/y.journal.jsonl");
		expect(resolveDelegateJournalTarget("./y.journal.jsonl", "/tmp/results")).toBe("./y.journal.jsonl");
	});
});

describe("handleDelegateCommand", () => {
	it("is inert for a non-delegate command", async () => {
		expect(await handleDelegateCommand(["peers"], { resultsDir: dir })).toBe(false);
	});

	it("prints help for bare `delegate`", async () => {
		expect(await handleDelegateCommand(["delegate"], { resultsDir: dir })).toBe(true);
		expect(stdoutText()).toContain("usage:");
		expect(stdoutText()).toContain("delegate watch");
		expect(stdoutText()).toContain("delegate list");
	});

	it("lists journals newest first with status, age, task, and model", async () => {
		const older = writeJournal(dir, "older", [
			{ t: 1000, type: "start", task: "old job", model: "m" },
			{ t: 5000, type: "end", status: "done", ok: true, summary: "s" },
		]);
		const newer = writeJournal(dir, "newer", [
			{ t: 9000, type: "start", task: "new job", model: "m2" },
			{ t: 9500, type: "assistant", text: "still going" },
		]);
		expect(older).toBeTruthy();
		expect(newer).toBeTruthy();
		expect(await handleDelegateCommand(["delegate", "list"], { resultsDir: dir, now: 10_000 })).toBe(true);
		const out = stdoutText();
		const newerIdx = out.indexOf("newer");
		const olderIdx = out.indexOf("older");
		expect(newerIdx).toBeGreaterThan(-1);
		expect(olderIdx).toBeGreaterThan(-1);
		expect(newerIdx).toBeLessThan(olderIdx);
		expect(out).toContain("new job");
		expect(out).toContain("old job");
		expect(out).toContain("RUNNING");
		expect(out).toContain("DONE");
		expect(out).toContain("m2");
	});

	it("list --json prints parseable records", async () => {
		writeJournal(dir, "h1", [
			{ t: 1000, type: "start", task: "job one" },
			{ t: 2000, type: "end", status: "done", ok: true, summary: "s" },
		]);
		expect(await handleDelegateCommand(["delegate", "list", "--json"], { resultsDir: dir, now: 5000 })).toBe(true);
		const parsed = JSON.parse(stdoutText());
		expect(parsed).toHaveLength(1);
		expect(parsed[0].handle).toBe("h1");
		expect(parsed[0].status).toBe("done");
		expect(parsed[0].task).toBe("job one");
	});

	it("watch prints a one-shot tail when stdout is not a TTY", async () => {
		writeJournal(dir, "h1", [
			{ t: 1000, type: "start", task: "watched job" },
			{ t: 1200, type: "assistant", text: "doing the work" },
		]);
		expect(
			await handleDelegateCommand(["delegate", "watch", "h1"], { resultsDir: dir, now: 3000, isTTY: false }),
		).toBe(true);
		const out = stdoutText();
		expect(out).toContain("task: watched job");
		expect(out).toContain("doing the work");
		expect(out).toContain("RUNNING");
	});

	it("watch reports an unknown handle on stderr and stays inert", async () => {
		expect(await handleDelegateCommand(["delegate", "watch", "nope"], { resultsDir: dir, isTTY: false })).toBe(true);
		expect(stdoutText()).toBe("");
		expect(stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("")).toContain("no journal");
	});

	it("watch --json dumps the parsed records", async () => {
		writeJournal(dir, "h1", [
			{ t: 1000, type: "start", task: "job" },
			{ t: 1100, type: "turn" },
		]);
		expect(
			await handleDelegateCommand(["delegate", "watch", "h1", "--json"], { resultsDir: dir, isTTY: false }),
		).toBe(true);
		const parsed = JSON.parse(stdoutText());
		expect(parsed).toHaveLength(2);
		expect(parsed[0].type).toBe("start");
	});
});
