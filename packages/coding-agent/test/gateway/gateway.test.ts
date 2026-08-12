import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryChannelIndex } from "../../src/gateway/channel-index.js";
import { fakeCompletionRunner, sessionIdForChannel } from "../../src/gateway/completion.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { GatewayMessage, GatewayTransport } from "../../src/gateway/types.js";

/** A scriptable in-memory transport. */
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
	return mkdtemp(join(tmpdir(), prefix));
}

describe("Gateway router", () => {
	it("denies a non-allowlisted sender before the model or commands", async () => {
		const dir = await home("axiom-gw-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+555"],
			});
			await g.start();
			push({ channelId: "+999", sender: "+999", text: "hi", isCommand: false, timestamp: 1 });
			push({ channelId: "+999", sender: "+999", text: "/help", isCommand: true, timestamp: 2 });
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.some((s) => s.text.includes("unrecognized sender"))).toBe(true);
			expect(completion.calls).toHaveLength(0);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("routes a message to an agent completion and indexes the channel session", async () => {
		const dir = await home("axiom-gw-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const index = new MemoryChannelIndex();
			const g = new Gateway({
				transport: t,
				index,
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
			});
			await g.start();
			push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(completion.calls).toHaveLength(1);
			expect(completion.calls[0]!.prompt).toBe("hello");
			const sid = completion.calls[0]!.sessionId;
			expect(sid).toBe(sessionIdForChannel("+1"));
			expect(index.get("+1")).toBe(sid);
			expect(sent.some((s) => s.text.startsWith("axiom reply"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("handles a command locally and never calls the model", async () => {
		const dir = await home("axiom-gw-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
			});
			await g.start();
			push({ channelId: "+1", sender: "+1", text: "/profiles", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(completion.calls).toHaveLength(0);
			expect(sent.some((s) => s.text.includes("no profiles yet"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("serializes two messages on one channel (no interleaved runs)", async () => {
		const dir = await home("axiom-gw-");
		try {
			const { t, push } = fakeTransport();
			let inFlight = 0;
			let maxInFlight = 0;
			const completion = {
				calls: [] as Array<{ sessionId: string; prompt: string }>,
				async runCompletion(input: { sessionId: string; prompt: string; profile: { name: string } }) {
					this.calls.push({ sessionId: input.sessionId, prompt: input.prompt });
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					await new Promise((r) => setTimeout(r, 10));
					inFlight--;
					return { reply: `reply:${input.prompt}`, sessionId: input.sessionId };
				},
			};
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
			});
			await g.start();
			push({ channelId: "+1", sender: "+1", text: "a", isCommand: false, timestamp: 1 });
			push({ channelId: "+1", sender: "+1", text: "b", isCommand: false, timestamp: 2 });
			await new Promise((r) => setTimeout(r, 60));
			expect(completion.calls.map((c) => c.prompt)).toEqual(["a", "b"]);
			expect(maxInFlight).toBe(1);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports a completion failure as a best-effort error reply", async () => {
		const dir = await home("axiom-gw-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = {
				calls: [] as unknown[],
				async runCompletion() {
					return { reply: "", sessionId: "s", error: "signal-cli missing" };
				},
			};
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
			});
			await g.start();
			push({ channelId: "+1", sender: "+1", text: "hi", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.some((s) => s.text.includes("could not run the agent"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("Gateway cron lifecycle + command wiring", () => {
	it("starts/stops the cron manager with the gateway and drives /cron with the channel", async () => {
		const dir = await home("axiom-gw-cron-");
		try {
			const { t, sent, push } = fakeTransport();
			const startCalls: string[] = [];
			const added: Array<{ channelId?: string; prompt: string }> = [];
			const cron = {
				start() {
					startCalls.push("start");
				},
				stop() {
					startCalls.push("stop");
				},
				listJobs() {
					return [];
				},
				removeJob() {
					return undefined;
				},
				addJob(input: { channelId: string; prompt: string }) {
					added.push({ channelId: input.channelId, prompt: input.prompt });
					return {
						id: "job-00000000-0000-0000-0000-000000000001",
						status: "active" as const,
						source: "cron" as const,
						channelId: input.channelId,
						activeSessionId: "s",
						sessionId: "s",
						sessionFile: "/tmp/s.jsonl",
						cwd: "/tmp",
						prompt: input.prompt,
						schedule: { kind: "interval" as const, expression: "every 5m", intervalMs: 300_000 },
						createdAt: new Date(0).toISOString(),
						updatedAt: new Date(0).toISOString(),
						runCount: 0,
					};
				},
			};
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion: fakeCompletionRunner(),
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+555"],
				cron,
			});
			await g.start();
			expect(startCalls).toEqual(["start"]);
			// A /cron add from an allowlisted channel passes the channel as the
			// delivery target to the manager.
			push({
				channelId: "+555",
				sender: "+555",
				text: "/cron add every 5m nightwatch",
				isCommand: true,
				timestamp: 1,
			});
			await new Promise((r) => setTimeout(r, 20));
			expect(added).toEqual([{ channelId: "+555", prompt: "nightwatch" }]);
			expect(sent.some((s) => s.text.includes("scheduled"))).toBe(true);
			await g.stop();
			expect(startCalls).toEqual(["start", "stop"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports cron-unwired when no manager is provided", async () => {
		const dir = await home("axiom-gw-");
		try {
			const { t, sent, push } = fakeTransport();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion: fakeCompletionRunner(),
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+555"],
			});
			await g.start();
			push({ channelId: "+555", sender: "+555", text: "/cron list", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.some((s) => s.text.includes("not wired"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
