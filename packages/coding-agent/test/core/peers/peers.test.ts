import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BoardFileStat } from "../../../src/core/peers/board.js";
import {
	heartbeatRun,
	inbox,
	listPeers,
	type PeekCache,
	peekInbox,
	registerRun,
	sendPeerMessage,
	setIntent,
} from "../../../src/core/peers/peers.js";
import { DEFAULT_STALE_MS } from "../../../src/core/peers/presence.js";
import type { PeerIdentity } from "../../../src/core/peers/types.js";

const NOW = 1_800_000_000_000;
const A: PeerIdentity = { instanceId: "aaa11111-1234-1234-1234-123456789012", shortId: "aaa11111" };
const B: PeerIdentity = { instanceId: "bbb22222-1234-1234-1234-123456789012", shortId: "bbb22222" };
const C: PeerIdentity = { instanceId: "ccc33333-1234-1234-1234-123456789012", shortId: "ccc33333" };

function scope(): string {
	return mkdtempSync(join(tmpdir(), "peers-fac-"));
}

describe("peers facade", () => {
	describe("peekInbox short circuit (stat-based)", () => {
		const statA = { size: 100, mtimeMs: 1_800_000_000_000 };

		it("skips board and cursor reads when the board stat is unchanged", () => {
			const s = scope();
			try {
				let reads = 0;
				const readSlice = (): string => {
					reads++;
					return "";
				};
				const statFile = (): BoardFileStat => statA;
				const cache: PeekCache = {};

				expect(peekInbox(s, B, cache, { statSize: () => statA.size, statFile, readSlice }).messages).toHaveLength(
					0,
				);
				const readsAfterFirst = reads;
				expect(readsAfterFirst).toBeGreaterThan(0);
				expect(peekInbox(s, B, cache, { statSize: () => statA.size, statFile, readSlice }).messages).toHaveLength(
					0,
				);
				expect(reads).toBe(readsAfterFirst);
			} finally {
				rmSync(s, { recursive: true, force: true });
			}
		});

		it("re-reads the board on a size-only or mtime-only stat change", () => {
			const s = scope();
			try {
				let reads = 0;
				const readSlice = (): string => {
					reads++;
					return "";
				};
				const statFile = (): BoardFileStat => statA;
				const cache: PeekCache = {};
				const peek = (): number =>
					peekInbox(s, B, cache, { statSize: () => statA.size, statFile, readSlice }).messages.length;

				peek();
				const afterFirst = reads;
				// size change, same mtime
				statA.size = 101;
				peek();
				expect(reads).toBeGreaterThan(afterFirst);
				const afterSize = reads;
				// mtime change, same size
				statA.mtimeMs = 1_800_000_000_001;
				peek();
				expect(reads).toBeGreaterThan(afterSize);
			} finally {
				rmSync(s, { recursive: true, force: true });
			}
		});

		it("returns the new messages after a changed board, then goes quiet while unchanged", () => {
			const s = scope();
			try {
				let stat = { size: 0, mtimeMs: 1_800_000_000_000 };
				let boardText = "";
				const readSlice = (path: string, from: number, to: number): string => {
					if (path.endsWith(`cursor-${B.instanceId}.json`)) return "0";
					return boardText.slice(from, to);
				};
				const statFile = (): BoardFileStat => stat;
				const cache: PeekCache = {};
				const peek = (): string[] =>
					peekInbox(s, B, cache, { statSize: () => stat.size, statFile, readSlice }).messages.map((m) => m.text);

				expect(peek()).toEqual([]);
				boardText = `${JSON.stringify({ ts: "t", from: A.instanceId, to: B.instanceId, text: "hi", kind: "msg" })}\n`;
				stat = { size: boardText.length, mtimeMs: 1_800_000_000_001 };
				expect(peek()).toEqual(["hi"]);
				// unchanged stat: quiet again, no parse
				expect(peek()).toEqual([]);
			} finally {
				rmSync(s, { recursive: true, force: true });
			}
		});
	});

	it("two instances see each other; a crashed one goes stale", () => {
		const s = scope();
		try {
			registerRun(s, A, { model: "m1", intent: "editing docs" }, { uuid: () => "run-a", pid: 101, now: () => NOW });
			registerRun(s, B, { model: "m2" }, { uuid: () => "run-b", pid: 102, now: () => NOW });
			registerRun(s, C, { model: "m3" }, { uuid: () => "run-c", pid: 103, now: () => NOW });
			const pidAlive = (pid: number) => pid !== 103;
			const list = listPeers(s, A, { now: () => NOW, staleMs: DEFAULT_STALE_MS, pidAlive });
			expect(list.self.map((p) => p.runId)).toEqual(["run-a"]);
			expect(list.active.map((p) => p.instanceId)).toEqual([B.instanceId]);
			expect(list.stale.map((p) => p.instanceId)).toEqual([C.instanceId]);
			expect(list.active[0]?.intent).toBe("");
			expect(list.active[0]?.model).toBe("m2");
			expect(list.active[0]?.status).toBe("active");
			expect(list.stale[0]?.status).toBe("stale");
		} finally {
			rmSync(s, { recursive: true, force: true });
		}
	});

	it("directed messages reach only the target; group messages reach all", () => {
		const s = scope();
		try {
			registerRun(s, A, {}, { uuid: () => "run-a", pid: 101, now: () => NOW });
			registerRun(s, B, {}, { uuid: () => "run-b", pid: 102, now: () => NOW });
			registerRun(s, C, {}, { uuid: () => "run-c", pid: 103, now: () => NOW });
			sendPeerMessage(s, A, "run-a", B.instanceId, "only for B", { now: () => NOW });

			expect(inbox(s, B).messages.map((m) => m.text)).toEqual(["only for B"]);
			expect(inbox(s, C).messages).toHaveLength(0);
			expect(inbox(s, A).messages).toHaveLength(0);

			sendPeerMessage(s, A, "run-a", "*", "everyone", { now: () => NOW });
			expect(inbox(s, B).messages.map((m) => m.text)).toEqual(["everyone"]);
			expect(inbox(s, C).messages.map((m) => m.text)).toEqual(["everyone"]);
		} finally {
			rmSync(s, { recursive: true, force: true });
		}
	});

	it("inbox marks read; peekInbox does not", () => {
		const s = scope();
		try {
			registerRun(s, A, {}, { uuid: () => "run-a", pid: 101 });
			registerRun(s, B, {}, { uuid: () => "run-b", pid: 102 });
			sendPeerMessage(s, A, "run-a", B.instanceId, "hello", { now: () => NOW });

			expect(peekInbox(s, B).messages.map((m) => m.text)).toEqual(["hello"]);
			expect(peekInbox(s, B).messages.map((m) => m.text)).toEqual(["hello"]);
			const read = inbox(s, B);
			expect(read.messages.map((m) => m.text)).toEqual(["hello"]);
			expect(inbox(s, B).messages).toHaveLength(0);
		} finally {
			rmSync(s, { recursive: true, force: true });
		}
	});

	it("intent updates are visible to peers and heartbeat keeps a run live", () => {
		const s = scope();
		try {
			registerRun(s, A, { intent: "starting" }, { uuid: () => "run-a", pid: 101, now: () => NOW });
			expect(setIntent(s, "run-a", "on branch feat/x", { now: () => NOW })).toBe(true);
			expect(
				listPeers(s, B, { now: () => NOW, staleMs: DEFAULT_STALE_MS, pidAlive: () => true }).active[0]?.intent,
			).toBe("on branch feat/x");
			expect(heartbeatRun(s, "run-a", { now: () => NOW + 60_000 })).toBe(true);
			expect(
				listPeers(s, B, { now: () => NOW + 60_000, staleMs: DEFAULT_STALE_MS, pidAlive: () => true }).active[0]
					?.status,
			).toBe("active");
		} finally {
			rmSync(s, { recursive: true, force: true });
		}
	});

	it("rejects empty or oversized messages and malformed targets", () => {
		const s = scope();
		try {
			registerRun(s, A, {}, { uuid: () => "run-a", pid: 101 });
			expect(() => sendPeerMessage(s, A, "run-a", B.instanceId, "   ", { now: () => NOW })).toThrow();
			expect(() => sendPeerMessage(s, A, "run-a", "bad target with spaces", "hi", { now: () => NOW })).toThrow();
			expect(() => sendPeerMessage(s, A, "run-a", B.instanceId, "x".repeat(4001), { now: () => NOW })).toThrow();
		} finally {
			rmSync(s, { recursive: true, force: true });
		}
	});
});
