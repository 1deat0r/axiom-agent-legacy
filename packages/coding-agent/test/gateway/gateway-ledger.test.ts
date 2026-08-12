import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryChannelIndex } from "../../src/gateway/channel-index.js";
import { dispatchCommand } from "../../src/gateway/commands/index.js";
import { fakeCompletionRunner } from "../../src/gateway/completion.js";
import { MemoryDeliveryLedger } from "../../src/gateway/delivery-ledger.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { GatewayMessage, GatewayTransport } from "../../src/gateway/types.js";

function fakeTransport() {
	const sent: Array<{ to: string; text: string }> = [];
	let handler: ((msg: GatewayMessage) => void) | undefined;
	const t: GatewayTransport = {
		async connect() {},
		async disconnect() {},
		async send(to, text) {
			sent.push({ to: to.recipient, text });
		},
		onMessage(h) {
			handler = h;
		},
	};
	return { t, sent, push: (m: GatewayMessage) => handler?.(m) };
}

async function home(prefix: string) {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	await mkdir(join(dir, "gateway"), { recursive: true });
	return dir;
}

describe("Gateway delivery ledger (ADR-0022)", () => {
	it("records every outbound delivery (reply + denial) into the ledger", async () => {
		const dir = await home("axiom-lg-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const ledger = new MemoryDeliveryLedger();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["U-OWNER"],
				ledger,
				transportName: "telegram",
			});
			await g.start();
			push({ channelId: "C1", sender: "U-OWNER", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			// The agent reply was delivered and recorded.
			expect(sent.some((s) => s.text.startsWith("axiom reply"))).toBe(true);
			const entries = ledger.recent(10);
			expect(entries).toHaveLength(1);
			expect(entries[0]!.channel).toBe("C1");
			expect(entries[0]!.recipient).toBe("U-OWNER");
			expect(entries[0]!.transport).toBe("telegram");
			expect(entries[0]!.ok).toBe(true);

			// A denied stranger also lands in the ledger (audit of the deny path).
			push({ channelId: "C1", sender: "U-STRANGER", text: "/help", isCommand: true, timestamp: 2 });
			await new Promise((r) => setTimeout(r, 20));
			expect(ledger.recent(10)).toHaveLength(2);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("fans one message out to every configured deliverTo channel and records each", async () => {
		const dir = await home("axiom-lg-");
		try {
			await writeFile(
				join(dir, "gateway", "config.json"),
				JSON.stringify({ senders: ["U-OWNER"], deliverTo: [{ channel: "C1" }, { channel: "C2" }] }),
			);
			const { t, sent } = fakeTransport();
			const ledger = new MemoryDeliveryLedger();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion: fakeCompletionRunner(),
				axiomHomeDir: dir,
				profile: "default",
				senders: ["U-OWNER"],
				ledger,
				transportName: "discord",
			});
			await g.start();
			const res = await g.deliverToAll("hello everyone");
			expect(res).toEqual({ channels: 2 });
			expect(sent.map((s) => s.text)).toEqual(["hello everyone", "hello everyone"]);
			const entries = ledger.recent(10);
			expect(entries).toHaveLength(2);
			expect(entries.map((e) => e.channel)).toEqual(["C1", "C2"]);
			expect(entries.every((e) => e.transport === "discord")).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("wires /ledger and /announce through the command context", async () => {
		const dir = await home("axiom-lg-");
		try {
			const ledger = new MemoryDeliveryLedger();
			ledger.record({
				ts: 1000,
				transport: "slack",
				channel: "C9",
				recipient: "U9",
				chars: 4,
				ok: true,
			});
			const ctx = { profile: "default", axiomHomeDir: dir, projectHome: dir, ledger };
			const out = dispatchCommand("/ledger", ctx);
			expect(out).toContain("slack -> C9");
			expect(out).toContain("ok");

			const deliverToAll = vi.fn(async () => ({ channels: 0 }));
			const ctx2 = { profile: "default", axiomHomeDir: dir, projectHome: dir, deliverToAll };
			const ann = dispatchCommand("/announce hello world", ctx2);
			expect(ann).toContain("announcing");
			expect(deliverToAll).toHaveBeenCalledWith("hello world");
			expect(dispatchCommand("/announce", ctx2)).toContain("nothing to send");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
