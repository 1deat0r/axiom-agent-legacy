/**
 * Multi-transport fan-out (issue #40): /announce and gateway broadcasts reach
 * every active transport — the primary plus every built fan-out sibling — not
 * just the channel's own transport. Named deliverTo targets keep their exact
 * transport; an UNNAMED target fans out to every transport the gateway holds.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryChannelIndex } from "../../src/gateway/channel-index.js";
import { fakeCompletionRunner } from "../../src/gateway/completion.js";
import { MemoryDeliveryLedger } from "../../src/gateway/delivery-ledger.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { GatewayMessage, GatewayTransport } from "../../src/gateway/types.js";

function fakeTransport() {
	const sent: Array<{ channelId: string; text: string }> = [];
	let handler: ((msg: GatewayMessage) => void) | undefined;
	const t: GatewayTransport = {
		async connect() {},
		async disconnect() {},
		async send(to, text) {
			sent.push({ channelId: to.channelId, text });
		},
		onMessage(h) {
			handler = h;
		},
	};
	return { t, sent, push: (m: GatewayMessage) => handler?.(m) };
}

async function home(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	await mkdir(join(dir, "gateway"), { recursive: true });
	return dir;
}

async function writeDeliverTo(dir: string, deliverTo: unknown): Promise<void> {
	await writeFile(join(dir, "gateway", "config.json"), JSON.stringify({ senders: ["U-OWNER"], deliverTo }));
}

function settle(ms = 40): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("multi-transport fan-out (issue #40)", () => {
	it("an unnamed deliverTo target reaches every active transport, ledger-labelled per platform", async () => {
		const dir = await home("axiom-fo-");
		try {
			await writeDeliverTo(dir, [{ channel: "C1" }]);
			const primary = fakeTransport();
			const slack = fakeTransport();
			const telegram = fakeTransport();
			const ledger = new MemoryDeliveryLedger();
			const g = new Gateway({
				transport: primary.t,
				index: new MemoryChannelIndex(),
				completion: fakeCompletionRunner(),
				axiomHomeDir: dir,
				profile: "default",
				senders: ["U-OWNER"],
				ledger,
				transportName: "discord",
				transports: { slack: slack.t, telegram: telegram.t },
			});
			await g.start();
			const res = await g.deliverToAll("hello everyone");
			expect(res).toEqual({ channels: 3 });
			expect(primary.sent.map((s) => s.channelId)).toEqual(["C1"]);
			expect(slack.sent.map((s) => s.channelId)).toEqual(["C1"]);
			expect(telegram.sent.map((s) => s.channelId)).toEqual(["C1"]);
			const entries = ledger.recent(10);
			expect(entries.map((e) => `${e.transport}->${e.channel}`).sort()).toEqual([
				"discord->C1",
				"slack->C1",
				"telegram->C1",
			]);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("a named target stays on its transport while unnamed targets fan out to all", async () => {
		const dir = await home("axiom-fo-");
		try {
			await writeDeliverTo(dir, [{ transport: "slack", channel: "S1" }, { channel: "C1" }]);
			const primary = fakeTransport();
			const slack = fakeTransport();
			const telegram = fakeTransport();
			const ledger = new MemoryDeliveryLedger();
			const g = new Gateway({
				transport: primary.t,
				index: new MemoryChannelIndex(),
				completion: fakeCompletionRunner(),
				axiomHomeDir: dir,
				profile: "default",
				senders: ["U-OWNER"],
				ledger,
				transportName: "discord",
				transports: { slack: slack.t, telegram: telegram.t },
			});
			await g.start();
			const res = await g.deliverToAll("hello everyone");
			// Named S1 -> slack only. Unnamed C1 -> discord + slack + telegram.
			expect(res).toEqual({ channels: 4 });
			expect(primary.sent.map((s) => s.channelId)).toEqual(["C1"]);
			expect(slack.sent.map((s) => s.channelId)).toEqual(["S1", "C1"]);
			expect(telegram.sent.map((s) => s.channelId)).toEqual(["C1"]);
			const entries = ledger.recent(10);
			expect(entries.map((e) => `${e.transport}->${e.channel}`).sort()).toEqual([
				"discord->C1",
				"slack->C1",
				"slack->S1",
				"telegram->C1",
			]);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("single-platform back-compat: unnamed targets stay on the only transport", async () => {
		const dir = await home("axiom-fo-");
		try {
			await writeDeliverTo(dir, [{ channel: "C1" }, { channel: "C2" }]);
			const primary = fakeTransport();
			const g = new Gateway({
				transport: primary.t,
				index: new MemoryChannelIndex(),
				completion: fakeCompletionRunner(),
				axiomHomeDir: dir,
				profile: "default",
				senders: ["U-OWNER"],
				transportName: "telegram",
			});
			await g.start();
			const res = await g.deliverToAll("hi");
			expect(res).toEqual({ channels: 2 });
			expect(primary.sent.map((s) => s.channelId)).toEqual(["C1", "C2"]);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("an unknown named transport degrades to the primary only (named entries never fan out)", async () => {
		const dir = await home("axiom-fo-");
		try {
			await writeDeliverTo(dir, [{ transport: "nope", channel: "X" }]);
			const primary = fakeTransport();
			const slack = fakeTransport();
			const g = new Gateway({
				transport: primary.t,
				index: new MemoryChannelIndex(),
				completion: fakeCompletionRunner(),
				axiomHomeDir: dir,
				profile: "default",
				senders: ["U-OWNER"],
				transportName: "discord",
				transports: { slack: slack.t },
			});
			await g.start();
			const res = await g.deliverToAll("hi");
			expect(res).toEqual({ channels: 1 });
			expect(primary.sent.map((s) => s.channelId)).toEqual(["X"]);
			expect(slack.sent).toHaveLength(0);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("/announce reaches every active transport through the router", async () => {
		const dir = await home("axiom-fo-");
		try {
			await writeDeliverTo(dir, [{ channel: "C1" }]);
			const primary = fakeTransport();
			const slack = fakeTransport();
			const g = new Gateway({
				transport: primary.t,
				index: new MemoryChannelIndex(),
				completion: fakeCompletionRunner(),
				axiomHomeDir: dir,
				profile: "default",
				senders: ["U-OWNER"],
				transportName: "discord",
				transports: { slack: slack.t },
			});
			await g.start();
			primary.push({
				channelId: "D-OWNER",
				sender: "U-OWNER",
				text: "/announce hello everyone",
				isCommand: true,
				timestamp: 1,
			});
			await settle();
			// The command reply goes to the owner; the fan-out reaches discord + slack.
			expect(primary.sent.some((s) => s.channelId === "D-OWNER" && s.text.includes("announcing"))).toBe(true);
			expect(primary.sent.some((s) => s.channelId === "C1" && s.text === "hello everyone")).toBe(true);
			expect(slack.sent.map((s) => s.channelId)).toEqual(["C1"]);
			expect(slack.sent[0]!.text).toBe("hello everyone");
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
