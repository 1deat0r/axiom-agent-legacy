import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_STALE_MS,
	heartbeatPresence,
	isPeerAlive,
	listPresence,
	presenceFile,
	unregisterPresence,
	writePresence,
} from "../../../src/core/peers/presence.js";
import type { PresenceRecord } from "../../../src/core/peers/types.js";

const NOW = 1_800_000_000_000;

function record(over: Partial<PresenceRecord> = {}): PresenceRecord {
	return {
		instanceId: "abc12345-1234-1234-1234-123456789012",
		runId: "run-1",
		pid: 42,
		model: "test-model",
		intent: "working on feat/x",
		startedAt: new Date(NOW).toISOString(),
		heartbeatAt: new Date(NOW).toISOString(),
		...over,
	};
}

describe("presence", () => {
	it("writes, lists, heartbeats, and unregisters", () => {
		const scope = mkdtempSync(join(tmpdir(), "peers-pres-"));
		try {
			const r = record();
			writePresence(scope, r);
			expect(existsSync(presenceFile(scope, r.runId))).toBe(true);
			expect(listPresence(scope)).toHaveLength(1);
			expect(heartbeatPresence(scope, r.runId, { now: () => NOW + 1000 })).toBe(true);
			expect(listPresence(scope)[0]?.heartbeatAt).toBe(new Date(NOW + 1000).toISOString());
			unregisterPresence(scope, r.runId);
			expect(listPresence(scope)).toHaveLength(0);
		} finally {
			rmSync(scope, { recursive: true, force: true });
		}
	});

	it("heartbeat of an unknown run is a no-op returning false", () => {
		const scope = mkdtempSync(join(tmpdir(), "peers-pres-"));
		try {
			expect(heartbeatPresence(scope, "missing-run", { now: () => NOW })).toBe(false);
		} finally {
			rmSync(scope, { recursive: true, force: true });
		}
	});

	it("skips malformed presence files", () => {
		const scope = mkdtempSync(join(tmpdir(), "peers-pres-"));
		try {
			writePresence(scope, record());
			writeFileSync(join(scope, "presence", "junk.json"), "not json");
			writeFileSync(join(scope, "presence", "notes.txt"), "ignore me");
			expect(listPresence(scope)).toHaveLength(1);
		} finally {
			rmSync(scope, { recursive: true, force: true });
		}
	});

	it("isPeerAlive: fresh heartbeat and live pid", () => {
		expect(isPeerAlive(record(), NOW + 1000, DEFAULT_STALE_MS, () => true)).toBe(true);
	});

	it("isPeerAlive: stale heartbeat is not alive", () => {
		expect(isPeerAlive(record(), NOW + DEFAULT_STALE_MS + 1, DEFAULT_STALE_MS, () => true)).toBe(false);
	});

	it("isPeerAlive: dead pid is not alive", () => {
		expect(isPeerAlive(record(), NOW, DEFAULT_STALE_MS, () => false)).toBe(false);
	});
});
