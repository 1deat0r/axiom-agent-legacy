import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_RLM_CHILD_STALL_MS,
	DEFAULT_STREAM_STALL_MAX_ATTEMPTS,
	DEFAULT_STREAM_STALL_TIMEOUT_MS,
	isRlmChildStalled,
	resolveRlmChildStallMs,
	resolveStreamStallMaxAttempts,
	resolveStreamStallTimeoutMs,
	rlmChildSessionLastWriteMs,
	rlmChildStallRefreshMs,
} from "../src/core/stall-watchdog.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "axiom-stall-watchdog-"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("resolveStreamStallTimeoutMs", () => {
	it("defaults to 120s when unset", () => {
		expect(resolveStreamStallTimeoutMs({})).toBe(DEFAULT_STREAM_STALL_TIMEOUT_MS);
		expect(DEFAULT_STREAM_STALL_TIMEOUT_MS).toBe(120_000);
	});

	it("accepts a valid override and treats zero as disabled", () => {
		expect(resolveStreamStallTimeoutMs({ AXIOM_STREAM_STALL_TIMEOUT_MS: "30000" })).toBe(30_000);
		expect(resolveStreamStallTimeoutMs({ AXIOM_STREAM_STALL_TIMEOUT_MS: "0" })).toBe(0);
	});

	it("falls back to the default for invalid values", () => {
		expect(resolveStreamStallTimeoutMs({ AXIOM_STREAM_STALL_TIMEOUT_MS: "soon" })).toBe(
			DEFAULT_STREAM_STALL_TIMEOUT_MS,
		);
		expect(resolveStreamStallTimeoutMs({ AXIOM_STREAM_STALL_TIMEOUT_MS: "-5" })).toBe(
			DEFAULT_STREAM_STALL_TIMEOUT_MS,
		);
	});
});

describe("resolveStreamStallMaxAttempts", () => {
	it("defaults to 2 attempts (one retry)", () => {
		expect(resolveStreamStallMaxAttempts({})).toBe(DEFAULT_STREAM_STALL_MAX_ATTEMPTS);
		expect(DEFAULT_STREAM_STALL_MAX_ATTEMPTS).toBe(2);
	});

	it("accepts a valid override", () => {
		expect(resolveStreamStallMaxAttempts({ AXIOM_STREAM_STALL_MAX_ATTEMPTS: "3" })).toBe(3);
	});

	it("falls back to the default for invalid values", () => {
		expect(resolveStreamStallMaxAttempts({ AXIOM_STREAM_STALL_MAX_ATTEMPTS: "many" })).toBe(
			DEFAULT_STREAM_STALL_MAX_ATTEMPTS,
		);
		expect(resolveStreamStallMaxAttempts({ AXIOM_STREAM_STALL_MAX_ATTEMPTS: "-2" })).toBe(
			DEFAULT_STREAM_STALL_MAX_ATTEMPTS,
		);
	});
});

describe("resolveRlmChildStallMs", () => {
	it("defaults to 10 minutes when unset", () => {
		expect(resolveRlmChildStallMs({})).toBe(DEFAULT_RLM_CHILD_STALL_MS);
		expect(DEFAULT_RLM_CHILD_STALL_MS).toBe(600_000);
	});

	it("accepts a valid override and treats zero as disabled", () => {
		expect(resolveRlmChildStallMs({ AXIOM_RLM_CHILD_STALL_MS: "60000" })).toBe(60_000);
		expect(resolveRlmChildStallMs({ AXIOM_RLM_CHILD_STALL_MS: "0" })).toBe(0);
	});

	it("falls back to the default for invalid values", () => {
		expect(resolveRlmChildStallMs({ AXIOM_RLM_CHILD_STALL_MS: "later" })).toBe(DEFAULT_RLM_CHILD_STALL_MS);
		expect(resolveRlmChildStallMs({ AXIOM_RLM_CHILD_STALL_MS: "-1" })).toBe(DEFAULT_RLM_CHILD_STALL_MS);
	});
});

describe("rlmChildSessionLastWriteMs", () => {
	it("returns the newest mtime among direct files and the harness subdir", () => {
		const sessionDir = join(dir, "child");
		const harnessDir = join(sessionDir, "harness");
		mkdirSync(harnessDir, { recursive: true });
		const older = join(sessionDir, "session.jsonl");
		const newest = join(harnessDir, "harness_state.json");
		writeFileSync(older, "x");
		writeFileSync(newest, "y");
		const base = Date.now();
		utimesSync(older, new Date(base - 60_000), new Date(base - 60_000));
		utimesSync(newest, new Date(base - 10_000), new Date(base - 10_000));

		const lastWrite = rlmChildSessionLastWriteMs(sessionDir);
		expect(lastWrite).toBeGreaterThan(0);
		expect(Math.abs(lastWrite! - (base - 10_000))).toBeLessThan(2_000);
	});

	it("returns undefined for a missing or empty directory", () => {
		expect(rlmChildSessionLastWriteMs(join(dir, "missing"))).toBeUndefined();
		mkdirSync(join(dir, "empty"));
		expect(rlmChildSessionLastWriteMs(join(dir, "empty"))).toBeUndefined();
	});
});

describe("isRlmChildStalled", () => {
	it("marks a child stalled when no writes happened within the threshold", () => {
		const sessionDir = join(dir, "child");
		mkdirSync(sessionDir);
		const file = join(sessionDir, "session.jsonl");
		writeFileSync(file, "x");
		const now = Date.now();
		utimesSync(file, new Date(now - 20 * 60_000), new Date(now - 20 * 60_000));

		expect(isRlmChildStalled(sessionDir, now, 600_000)).toBe(true);
		expect(isRlmChildStalled(sessionDir, now, 30 * 60_000)).toBe(false);
	});

	it("is never stalled without proof of activity", () => {
		expect(isRlmChildStalled(join(dir, "missing"), Date.now(), 600_000)).toBe(false);
	});

	it("is disabled when the threshold is zero", () => {
		const sessionDir = join(dir, "child");
		mkdirSync(sessionDir);
		const file = join(sessionDir, "session.jsonl");
		writeFileSync(file, "x");
		const now = Date.now();
		utimesSync(file, new Date(now - 60 * 60_000), new Date(now - 60 * 60_000));

		expect(isRlmChildStalled(sessionDir, now, 0)).toBe(false);
	});
});

describe("rlmChildStallRefreshMs", () => {
	it("derives a bounded refresh cadence from the stall threshold", () => {
		expect(rlmChildStallRefreshMs(600_000)).toBe(60_000);
		expect(rlmChildStallRefreshMs(10_000)).toBe(5_000);
		expect(rlmChildStallRefreshMs(40_000)).toBe(10_000);
		expect(rlmChildStallRefreshMs(0)).toBeUndefined();
	});
});
