/**
 * Axiom ledger x real v0.7.2 session-format regression test. The ledger
 * derives spend from the recorded session file, so a drift in the v0.7.2
 * session-file format (header line, entry shapes, assistant-message usage)
 * must not silently under-count. This writes a file in the baseline's actual
 * format and drives the ledger's real parse + aggregate path over it.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEntriesFromFile } from "../../src/core/session-manager.js";
import { aggregateUsage, applyOverrides } from "../../src/extensions/ledger/ledger.js";

// The baseline's real session-entry serialization (header + assistant message
// carrying Usage + a non-usage entry the ledger must ignore).
function sessionFile(): string {
	const header = {
		type: "session",
		version: 3,
		id: "019f-sec-001",
		timestamp: "2026-08-12T00:00:00.000Z",
		cwd: "/tmp/proj",
		rlmDepth: 0,
	};
	const assistant = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: "2026-08-12T00:00:01.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			responseModel: "claude-sonnet-4-20250514",
			usage: {
				input: 1_000_000,
				output: 500_000,
				cacheRead: 100_000,
				cacheWrite: 10_000,
				totalTokens: 1_610_000,
				cost: {
					input: 3.0,
					output: 7.5,
					cacheRead: 0.05,
					cacheWrite: 2.0,
					total: 12.55,
				},
			},
			stopReason: "stop",
			timestamp: 1723404001000,
		},
	};
	const user = {
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: "2026-08-12T00:00:00.500Z",
		message: { role: "user", content: "hi", timestamp: 1723404000500 },
	};
	const nop = {
		type: "thinking_level_change",
		id: "t1",
		parentId: null,
		timestamp: "2026-08-12T00:00:00.250Z",
		thinkingLevel: "off",
	};
	return [header, assistant, user, nop].map((o) => JSON.stringify(o)).join("\n");
}

describe("ledger x real v0.7.2 session format", () => {
	it("parses the baseline session file and prices the assistant usage", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-ledger-format-"));
		try {
			const path = join(dir, "session.jsonl");
			await writeFile(path, sessionFile(), "utf8");
			const entries = loadEntriesFromFile(path).filter((e) => e.type !== "session");
			const buckets = aggregateUsage(entries);
			expect(buckets).toHaveLength(1);
			expect(buckets[0]!.key).toBe("anthropic/claude-sonnet-4-20250514");
			// recorded cost is carried (no override) and never invented
			expect(buckets[0]!.recordedCost).toBeCloseTo(12.55, 9);
			const { totals } = applyOverrides(buckets, new Map());
			expect(totals.cost).toBeCloseTo(12.55, 9);
			expect(totals.input).toBe(1_000_000);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
