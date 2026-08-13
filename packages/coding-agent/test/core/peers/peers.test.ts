import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_STALE_MS } from "../../../src/core/peers/presence.js";
import {
	heartbeatRun,
	inbox,
	listPeers,
	peekInbox,
	registerRun,
	sendPeerMessage,
	setIntent,
} from "../../../src/core/peers/peers.js";
import type { PeerIdentity } from "../../../src/core/peers/types.js";

const NOW = 1_800_000_000_000;
const A: PeerIdentity = { instanceId: "aaa11111-1234-1234-1234-123456789012", shortId: "aaa11111" };
const B: PeerIdentity = { instanceId: "bbb22222-1234-1234-1234-123456789012", shortId: "bbb22222" };
const C: PeerIdentity = { instanceId: "ccc33333-1234-1234-1234-123456789012", shortId: "ccc33333" };

function scope(): string {
	return mkdtempSync(join(tmpdir(), "peers-fac-"));
}

describe("peers facade", () => {
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
