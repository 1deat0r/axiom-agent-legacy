import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { activeModelPath, FileActiveModelStore } from "../../src/gateway/active-model.js";
import { MemoryActiveProjectStore } from "../../src/gateway/active-project.js";
import { MemoryChannelIndex } from "../../src/gateway/channel-index.js";
import { fakeCompletionRunner, sessionIdForChannel } from "../../src/gateway/completion.js";
import { GatewayCron } from "../../src/gateway/cron.js";
import { MemoryDeliveryLedger } from "../../src/gateway/delivery-ledger.js";
import { Gateway } from "../../src/gateway/gateway.js";
import { InMemoryRestartNoticeStore } from "../../src/gateway/restart-notice.js";
import {
	GATEWAY_SESSION_BUDGET_BYTES,
	SESSION_RESET_NOTICE,
	sessionFilePath,
} from "../../src/gateway/session-reset.js";
import { FileStreamJournal } from "../../src/gateway/stream-journal.js";
import type { CompletionRunner, GatewayMessage, GatewayRecipient, GatewayTransport } from "../../src/gateway/types.js";

/** A scriptable in-memory transport that also supports streaming edits. */
function streamingTransport() {
	const sent: Array<{ to: string; text: string }> = [];
	const placed: Array<{ to: string; text: string }> = [];
	const edits: Array<{ chatId: string; messageId: number; text: string }> = [];
	const chatActions: Array<{ to: string; action: string }> = [];
	let id = 0;
	let handler: ((msg: GatewayMessage) => void) | undefined;
	let failEdit = false;
	const t: GatewayTransport & {
		sendMessage(to: GatewayRecipient, text: string): Promise<number>;
		editMessage(chatId: string, messageId: number, text: string): Promise<void>;
	} = {
		async connect() {},
		async disconnect() {},
		async send(to, text) {
			sent.push({ to: to.recipient, text });
		},
		async sendMessage(to, text) {
			placed.push({ to: to.recipient, text });
			return ++id;
		},
		async editMessage(chatId, messageId, text) {
			if (failEdit) throw new Error("edit failed");
			edits.push({ chatId, messageId, text });
		},
		async sendChatAction(to, action) {
			chatActions.push({ to: to.recipient, action });
		},
		onMessage(h) {
			handler = h;
		},
	};
	return {
		t,
		sent,
		placed,
		edits,
		chatActions,
		push: (m: GatewayMessage) => handler?.(m),
		setFailEdit(v: boolean) {
			failEdit = v;
		},
	};
}

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

describe("full /cron path through a real Gateway + GatewayCron", () => {
	it("a /cron add message schedules, and the fired run delivers to the channel", async () => {
		const dir = await home("axiom-gw-e2ecron-");
		try {
			const { t, sent, push } = fakeTransport();
			const cronCompletion = fakeCompletionRunner();
			const cron = new GatewayCron({
				storePath: join(dir, "cron-jobs.json"),
				completion: cronCompletion,
				transport: t,
				profile: "default",
				projectHome: dir,
			});
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
			// Real command message: scheduling reply goes back to the sender.
			push({
				channelId: "+555",
				sender: "+555",
				text: "/cron add every 1h nightly report",
				isCommand: true,
				timestamp: 1,
			});
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.some((s) => s.text.includes("scheduled"))).toBe(true);
			// The job is in the profile store with the right prompt + channel.
			const job = cron.listJobs().find((j) => j.status === "active");
			expect(job?.prompt).toBe("nightly report");
			expect(job?.channelId).toBe("+555");
			// Fire the due run: the reply is delivered to the job's channel.
			await cron.runDue(new Date(Date.parse(job?.nextRunAt ?? "")));
			await g.stop();
			expect(sent.some((s) => s.to === "+555" && s.text === "axiom reply to: nightly report")).toBe(true);
			// Cron ran on its namespaced session, never the interactive one.
			expect(cronCompletion.calls[0]?.sessionId).toBe(`cron-${sessionIdForChannel("+555")}`);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("Gateway /model hotswap", () => {
	it("threads a /model-set provider+model into the next completion", async () => {
		const dir = await home("axiom-gw-model-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const modelStore = new FileActiveModelStore(activeModelPath(dir, "default"));
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				modelStore,
			});
			await g.start();
			// operator sets the model via /model (a gateway-local command)
			push({
				channelId: "+1",
				sender: "+1",
				text: "/model deepseek deepseek-v4-pro",
				isCommand: true,
				timestamp: 1,
			});
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.some((s) => s.text.includes("model set to deepseek/deepseek-v4-pro"))).toBe(true);
			// persisted
			expect(modelStore.load()).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
			// next agent run carries the model
			push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 2 });
			await new Promise((r) => setTimeout(r, 20));
			expect(completion.calls.length).toBeGreaterThan(0);
			expect(completion.calls.at(-1)!.model).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("persists a bare /model <model> (empty provider) across load() and threads it into the next completion", async () => {
		const dir = await home("axiom-gw-model-");
		try {
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const modelStore = new FileActiveModelStore(activeModelPath(dir, "default"));
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				modelStore,
			});
			await g.start();
			push({
				channelId: "+1",
				sender: "+1",
				text: "/model deepseek-v4-pro",
				isCommand: true,
				timestamp: 1,
			});
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.some((s) => s.text.includes("model set to deepseek-v4-pro"))).toBe(true);
			// persisted with an empty provider — the gateway reloads per completion
			expect(modelStore.load()).toEqual({ provider: "", model: "deepseek-v4-pro" });
			push({ channelId: "+1", sender: "+1", text: "hello again", isCommand: false, timestamp: 2 });
			await new Promise((r) => setTimeout(r, 20));
			expect(completion.calls.at(-1)!.model).toEqual({ provider: "", model: "deepseek-v4-pro" });
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("Gateway live project switching", () => {
	async function projHome(prefix: string, projects: string[]): Promise<string> {
		const dir = await home(prefix);
		for (const p of projects) {
			await import("node:fs/promises").then((fs) => fs.mkdir(join(dir, "projects", p), { recursive: true }));
		}
		return dir;
	}

	it("(a,b,c) use switches and resumes project-scoped sessions per channel", async () => {
		const dir = await projHome("axiom-gw-sw-", ["alpha", "beta"]);
		try {
			const { t, push } = fakeTransport();
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
			push({ channelId: "+1", sender: "+1", text: "/projects use alpha", isCommand: true, timestamp: 2 });
			push({ channelId: "+1", sender: "+1", text: "in alpha", isCommand: false, timestamp: 3 });
			push({ channelId: "+1", sender: "+1", text: "/projects use beta", isCommand: true, timestamp: 4 });
			push({ channelId: "+1", sender: "+1", text: "in beta", isCommand: false, timestamp: 5 });
			push({ channelId: "+1", sender: "+1", text: "/projects use alpha", isCommand: true, timestamp: 6 });
			push({ channelId: "+1", sender: "+1", text: "back in alpha", isCommand: false, timestamp: 7 });
			await new Promise((r) => setTimeout(r, 40));
			const unanchored = sessionIdForChannel("+1");
			const alpha = sessionIdForChannel("+1:alpha:0");
			const beta = sessionIdForChannel("+1:beta:0");
			expect(completion.calls.map((c) => c.sessionId)).toEqual([
				unanchored,
				alpha,
				beta,
				alpha, // (c) resumes A's session
			]);
			// (a) the anchored runs pass the project root through.
			expect(completion.calls[1]!.projectRoot).toBe(join(dir, "projects", "alpha"));
			expect(completion.calls[2]!.projectRoot).toBe(join(dir, "projects", "beta"));
			expect(completion.calls[3]!.projectRoot).toBe(join(dir, "projects", "alpha"));
			expect(completion.calls[0]!.projectRoot).toBeUndefined();
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("(d) unset active project keeps the unanchored channel session (back-compat)", async () => {
		const dir = await projHome("axiom-gw-bc-", ["alpha"]);
		try {
			const { t, push } = fakeTransport();
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
			push({ channelId: "+1", sender: "+1", text: "hi", isCommand: false, timestamp: 1 });
			push({ channelId: "+1", sender: "+1", text: "again", isCommand: false, timestamp: 2 });
			await new Promise((r) => setTimeout(r, 30));
			expect(completion.calls.map((c) => c.sessionId)).toEqual([
				sessionIdForChannel("+1"),
				sessionIdForChannel("+1"),
			]);
			expect(completion.calls.every((c) => c.projectRoot === undefined)).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("(e) two channels keep independent active projects", async () => {
		const dir = await projHome("axiom-gw-2c-", ["alpha", "beta"]);
		try {
			const { t, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1", "+2"],
			});
			await g.start();
			push({ channelId: "+1", sender: "+1", text: "/projects use alpha", isCommand: true, timestamp: 1 });
			push({ channelId: "+2", sender: "+2", text: "/projects use beta", isCommand: true, timestamp: 2 });
			push({ channelId: "+1", sender: "+1", text: "m1", isCommand: false, timestamp: 3 });
			push({ channelId: "+2", sender: "+2", text: "m2", isCommand: false, timestamp: 4 });
			await new Promise((r) => setTimeout(r, 40));
			expect(completion.calls[0]!.sessionId).toBe(sessionIdForChannel("+1:alpha:0"));
			expect(completion.calls[0]!.projectRoot).toBe(join(dir, "projects", "alpha"));
			expect(completion.calls[1]!.sessionId).toBe(sessionIdForChannel("+2:beta:0"));
			expect(completion.calls[1]!.projectRoot).toBe(join(dir, "projects", "beta"));
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("(f) rm via the command clears store + composite index; messages fall back to unanchored", async () => {
		const dir = await projHome("axiom-gw-rm2-", ["alpha"]);
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
			push({ channelId: "+1", sender: "+1", text: "/projects use alpha", isCommand: true, timestamp: 1 });
			push({ channelId: "+1", sender: "+1", text: "in alpha", isCommand: false, timestamp: 2 });
			push({ channelId: "+1", sender: "+1", text: "/projects rm alpha", isCommand: true, timestamp: 3 });
			push({ channelId: "+1", sender: "+1", text: "after rm", isCommand: false, timestamp: 4 });
			await new Promise((r) => setTimeout(r, 40));
			expect(completion.calls[1]!.sessionId).toBe(sessionIdForChannel("+1")); // unanchored again
			expect(completion.calls[1]!.projectRoot).toBeUndefined();
			expect(index.get("+1:alpha:0")).toBeNull(); // composite entry dropped
			expect(sent.some((s) => s.text.includes("removed"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("(f2) out-of-band delete self-heals: clears store + composite index, runs unanchored", async () => {
		const dir = await projHome("axiom-gw-rm3-", ["alpha"]);
		try {
			const { t, push } = fakeTransport();
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
			push({ channelId: "+1", sender: "+1", text: "/projects use alpha", isCommand: true, timestamp: 1 });
			push({ channelId: "+1", sender: "+1", text: "in alpha", isCommand: false, timestamp: 2 });
			await new Promise((r) => setTimeout(r, 30));
			expect(completion.calls[0]!.sessionId).toBe(sessionIdForChannel("+1:alpha:0"));
			// Out-of-band deletion (not via /projects rm).
			await import("node:fs/promises").then((fs) =>
				fs.rm(join(dir, "projects", "alpha"), { recursive: true, force: true }),
			);
			push({ channelId: "+1", sender: "+1", text: "after delete", isCommand: false, timestamp: 3 });
			await new Promise((r) => setTimeout(r, 30));
			expect(completion.calls[1]!.sessionId).toBe(sessionIdForChannel("+1"));
			expect(completion.calls[1]!.projectRoot).toBeUndefined();
			expect(index.get("+1:alpha:0")).toBeNull();
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("(g) rm -> add -> use starts a FRESH session (generation in the key)", async () => {
		const dir = await projHome("axiom-gw-fr-", ["alpha"]);
		try {
			const { t, push } = fakeTransport();
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
			push({ channelId: "+1", sender: "+1", text: "/projects use alpha", isCommand: true, timestamp: 1 });
			push({ channelId: "+1", sender: "+1", text: "gen0", isCommand: false, timestamp: 2 });
			push({ channelId: "+1", sender: "+1", text: "/projects rm alpha", isCommand: true, timestamp: 3 });
			push({ channelId: "+1", sender: "+1", text: "/projects add alpha", isCommand: true, timestamp: 4 });
			push({ channelId: "+1", sender: "+1", text: "/projects use alpha", isCommand: true, timestamp: 5 });
			push({ channelId: "+1", sender: "+1", text: "gen1", isCommand: false, timestamp: 6 });
			await new Promise((r) => setTimeout(r, 50));
			expect(completion.calls[0]!.sessionId).toBe(sessionIdForChannel("+1:alpha:0"));
			expect(completion.calls[1]!.sessionId).toBe(sessionIdForChannel("+1:alpha:1"));
			expect(completion.calls[1]!.sessionId).not.toBe(completion.calls[0]!.sessionId);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("Gateway hand-edited store guard", () => {
	it("(h) an invalid stored project name self-heals to unanchored", async () => {
		const dir = await home("axiom-gw-he-");
		await import("node:fs/promises").then((fs) => fs.mkdir(join(dir, "projects", "alpha"), { recursive: true }));
		try {
			const { t, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const index = new MemoryChannelIndex();
			const store = new MemoryActiveProjectStore();
			store.set("+1", ".."); // hand-edited value that /projects use rejects
			const g = new Gateway({
				transport: t,
				index,
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				activeProjects: store,
			});
			await g.start();
			push({ channelId: "+1", sender: "+1", text: "hi", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(completion.calls[0]!.sessionId).toBe(sessionIdForChannel("+1"));
			expect(completion.calls[0]!.projectRoot).toBeUndefined();
			expect(store.get("+1")).toBeUndefined();
			expect(index.get("+1:..:0")).toBeNull();
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("Gateway restart notice", () => {
	it("announces 'back online' on start when a notice is recorded, then clears it", async () => {
		const dir = await home("axiom-gw-notice-");
		try {
			const { t, sent } = fakeTransport();
			const store = new InMemoryRestartNoticeStore();
			store.write({ sha: "abc12345", channelId: "+1" });
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion: fakeCompletionRunner(),
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				restartNoticeStore: store,
			});
			await g.start();
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.some((s) => s.text.includes("back online"))).toBe(true);
			expect(sent.some((s) => s.text.includes("abc12345"))).toBe(true);
			expect(store.readAndClear()).toBeUndefined();
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not announce when no notice is recorded", async () => {
		const dir = await home("axiom-gw-notice-");
		try {
			const { t, sent } = fakeTransport();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion: fakeCompletionRunner(),
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				restartNoticeStore: new InMemoryRestartNoticeStore(),
			});
			await g.start();
			await new Promise((r) => setTimeout(r, 20));
			expect(sent.some((s) => s.text.includes("back online"))).toBe(false);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("Gateway streaming replies", () => {
	it("streams an agent run into one edited bubble without a duplicate batch send", async () => {
		const dir = await home("axiom-gw-stream-");
		try {
			const s = streamingTransport();
			const completion = fakeCompletionRunner();
			const g = new Gateway({
				transport: s.t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(s.placed).toHaveLength(1); // one placeholder bubble
			expect(s.placed[0]!.text).toBe("…");
			expect(s.edits.length).toBeGreaterThan(0);
			expect(s.edits.at(-1)!.text).toBe("axiom reply to: hello");
			expect(s.sent).toHaveLength(0); // no batch fallback => no duplicate
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("falls back to a batch send when the final edit fails", async () => {
		const dir = await home("axiom-gw-stream-");
		try {
			const s = streamingTransport();
			const completion: CompletionRunner = {
				async runCompletion(input) {
					return { reply: "batch", sessionId: input.sessionId };
				},
				async streamCompletion(input, onDelta) {
					onDelta("partial"); // bubble ends at "partial"
					return { reply: "final different", sessionId: input.sessionId }; // differs => final edit
				},
			};
			s.setFailEdit(true);
			const g = new Gateway({
				transport: s.t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(s.sent.some((x) => x.text === "final different")).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("pauses the transport's poll loop while a reply is being delivered", async () => {
		const dir = await home("axiom-gw-stream-");
		try {
			const s = streamingTransport();
			const events: string[] = [];
			s.t.pausePolling = () => events.push("pause");
			s.t.resumePolling = () => events.push("resume");
			let release: (() => void) | undefined;
			const completion: CompletionRunner = {
				async runCompletion(input) {
					return { reply: "x", sessionId: input.sessionId };
				},
				async streamCompletion(input, _onDelta) {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return { reply: "streamed reply", sessionId: input.sessionId };
				},
			};
			const g = new Gateway({
				transport: s.t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(events).toEqual(["pause"]); // held before the completion even starts
			release?.();
			await new Promise((r) => setTimeout(r, 30));
			expect(events).toEqual(["pause", "resume"]); // released after the reply landed
			expect(s.edits.some((x) => x.text === "streamed reply")).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("pauses the transport's poll loop around a command/denial reply too", async () => {
		const dir = await home("axiom-gw-stream-");
		try {
			const s = streamingTransport();
			const events: string[] = [];
			s.t.pausePolling = () => events.push("pause");
			s.t.resumePolling = () => events.push("resume");
			const g = new Gateway({
				transport: s.t,
				index: new MemoryChannelIndex(),
				completion: fakeCompletionRunner(),
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
			});
			await g.start();
			// Not allowlisted: the denial reply must also go out without a poll
			// queuing it behind the open long-poll.
			s.push({ channelId: "+1", sender: "+999", text: "hi", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(events).toEqual(["pause", "resume"]);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("records a streamed reply in the delivery ledger exactly once", async () => {
		const dir = await home("axiom-gw-stream-");
		try {
			const s = streamingTransport();
			const completion: CompletionRunner = {
				async runCompletion(input) {
					return { reply: "x", sessionId: input.sessionId };
				},
				async streamCompletion(input, onDelta) {
					onDelta("streamed");
					return { reply: "streamed reply", sessionId: input.sessionId };
				},
			};
			const ledger = new MemoryDeliveryLedger();
			const g = new Gateway({
				transport: s.t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				ledger,
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			const entries = ledger.recent(10);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ transport: "transport", channel: "+1", ok: true, chars: 14 });
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not double-record when the final edit fails and falls back to a fresh send", async () => {
		const dir = await home("axiom-gw-stream-");
		try {
			const s = streamingTransport();
			const completion: CompletionRunner = {
				async runCompletion(input) {
					return { reply: "batch", sessionId: input.sessionId };
				},
				async streamCompletion(input, onDelta) {
					onDelta("partial");
					return { reply: "final different", sessionId: input.sessionId };
				},
			};
			s.setFailEdit(true);
			const ledger = new MemoryDeliveryLedger();
			const g = new Gateway({
				transport: s.t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				ledger,
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			const entries = ledger.recent(10);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ ok: true, chars: "final different".length });
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("pings a typing action while the run thinks and stops once text flows", async () => {
		vi.useFakeTimers();
		try {
			const dir = await home("axiom-gw-stream-");
			try {
				const s = streamingTransport();
				let release: (() => void) | undefined;
				let onDeltaRef: ((delta: string) => void) | undefined;
				const completion: CompletionRunner = {
					async runCompletion(input) {
						return { reply: "x", sessionId: input.sessionId };
					},
					async streamCompletion(input, onDelta) {
						onDeltaRef = onDelta;
						await new Promise<void>((resolve) => {
							release = resolve;
						}); // hold the stream open (model still "thinking")
						return { reply: "axiom reply", sessionId: input.sessionId };
					},
				};
				const g = new Gateway({
					transport: s.t,
					index: new MemoryChannelIndex(),
					completion,
					axiomHomeDir: dir,
					profile: "default",
					senders: ["+1"],
				});
				await g.start();
				s.push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 1 });
				await vi.advanceTimersByTimeAsync(10_000); // pings every 4s
				const pingsBefore = s.chatActions.length;
				expect(pingsBefore).toBeGreaterThanOrEqual(2);
				expect(s.chatActions.every((a) => a.action === "typing")).toBe(true);
				onDeltaRef?.("first");
				await vi.advanceTimersByTimeAsync(20_000);
				expect(s.chatActions.length).toBe(pingsBefore); // stopped refreshing once text flows
				release?.();
				await vi.advanceTimersByTimeAsync(0);
				await g.stop();
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("pings typing on the batch path and stops when the reply lands", async () => {
		vi.useFakeTimers();
		try {
			const dir = await home("axiom-gw-stream-");
			try {
				const s = streamingTransport();
				let release: (() => void) | undefined;
				const completion: CompletionRunner = {
					async runCompletion(input) {
						await new Promise<void>((resolve) => {
							release = resolve;
						});
						return { reply: "batch reply", sessionId: input.sessionId };
					},
				};
				const g = new Gateway({
					transport: s.t,
					index: new MemoryChannelIndex(),
					completion,
					axiomHomeDir: dir,
					profile: "default",
					senders: ["+1"],
				});
				await g.start();
				s.push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 1 });
				await vi.advanceTimersByTimeAsync(9_000);
				const pingsBefore = s.chatActions.length;
				expect(pingsBefore).toBeGreaterThanOrEqual(2);
				release?.();
				await vi.advanceTimersByTimeAsync(20_000);
				expect(s.chatActions.length).toBe(pingsBefore); // no more pings after the reply
				expect(s.sent.some((x) => x.text === "batch reply")).toBe(true);
				await g.stop();
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("journals the bubble while the stream is in flight and clears it on completion", async () => {
		const dir = await home("axiom-gw-stream-");
		try {
			const s = streamingTransport();
			let release: (() => void) | undefined;
			const completion: CompletionRunner = {
				async runCompletion(input) {
					return { reply: "x", sessionId: input.sessionId };
				},
				async streamCompletion(input, onDelta) {
					onDelta("half");
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return { reply: "done", sessionId: input.sessionId };
				},
			};
			const journal = new FileStreamJournal(join(dir, "streams.jsonl"));
			const g = new Gateway({
				transport: s.t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				streamJournal: journal,
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			const inFlight = journal.load();
			expect(inFlight).toHaveLength(1);
			expect(inFlight[0]).toMatchObject({ channelId: "+1", messageId: 1 });
			release?.();
			await new Promise((r) => setTimeout(r, 30));
			expect(journal.load()).toEqual([]);
			expect(s.sent).toHaveLength(0); // streamed to the bubble, no fallback
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("archives an oversized session before a run and notes the reset in the bubble", async () => {
		const dir = await home("axiom-gw-stream-");
		try {
			const s = streamingTransport();
			const completion = fakeCompletionRunner();
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const sessionPath = sessionFilePath(sessionsDir, "+1");
			writeFileSync(sessionPath, `${"x".repeat(GATEWAY_SESSION_BUDGET_BYTES + 1)}\n`, "utf8");
			const g = new Gateway({
				transport: s.t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				sessionsDir,
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "hello", isCommand: false, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(existsSync(sessionPath)).toBe(false); // archived away
			const archived = readdirSync(sessionsDir).find((f) =>
				f.startsWith(`${sessionIdForChannel("+1")}.jsonl.archived-`),
			);
			expect(archived).toBeDefined();
			const shown = s.edits.map((e) => e.text).join("\n");
			expect(shown).toContain(SESSION_RESET_NOTICE);
			expect(s.edits.at(-1)!.text).toBe(`${SESSION_RESET_NOTICE}\n\naxiom reply to: hello`);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("/new archives the channel session via the command surface", async () => {
		const dir = await home("axiom-gw-stream-");
		try {
			const s = streamingTransport();
			const completion = fakeCompletionRunner();
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const sessionPath = sessionFilePath(sessionsDir, "+1");
			writeFileSync(sessionPath, '{"type":"session"}\n', "utf8");
			const g = new Gateway({
				transport: s.t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				sessionsDir,
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "/new", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(existsSync(sessionPath)).toBe(false);
			expect(readdirSync(sessionsDir).some((f) => f.includes(".archived-"))).toBe(true);
			expect(s.sent.some((x) => x.text.includes("started a fresh session"))).toBe(true);
			// second /new: nothing left to archive
			s.push({ channelId: "+1", sender: "+1", text: "/new", isCommand: true, timestamp: 2 });
			await new Promise((r) => setTimeout(r, 30));
			expect(s.sent.some((x) => x.text.includes("no session to reset"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("Gateway /new stale-project self-heal", () => {
	it("/new after an out-of-band project delete clears the stale mapping and archives the current session", async () => {
		const dir = await home("axiom-gw-new-stale-");
		try {
			const s = streamingTransport();
			const completion = fakeCompletionRunner();
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			// The channel's real current session: after the project dir vanished,
			// the run path self-heals to the unanchored key, so this is the file
			// the next run will resume.
			const channelPath = sessionFilePath(sessionsDir, "+1");
			writeFileSync(channelPath, '{"type":"session"}\n', "utf8");
			// The dead composite session from before the deletion — /new must not
			// archive this one (the run path only drops its index entry).
			const stalePath = sessionFilePath(sessionsDir, "+1:alpha:0");
			writeFileSync(stalePath, '{"type":"session"}\n', "utf8");
			const index = new MemoryChannelIndex();
			const store = new MemoryActiveProjectStore();
			store.set("+1", "alpha"); // projects/alpha was deleted out-of-band
			const g = new Gateway({
				transport: s.t,
				index,
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				sessionsDir,
				activeProjects: store,
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "/new", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(existsSync(channelPath)).toBe(false); // the current session is archived
			expect(
				readdirSync(sessionsDir).some((f) => f.startsWith(`${sessionIdForChannel("+1")}.jsonl.archived-`)),
			).toBe(true);
			expect(existsSync(stalePath)).toBe(true); // the dead composite file is left for /search, like the run path leaves it
			expect(store.get("+1")).toBeUndefined(); // stale mapping cleared
			expect(index.get("+1:alpha:0")).toBeNull(); // composite index entry dropped
			expect(s.sent.some((x) => x.text.includes("started a fresh session"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("/new with an invalid stored project name self-heals and archives the channel session", async () => {
		const dir = await home("axiom-gw-new-invalid-");
		try {
			const s = streamingTransport();
			const completion = fakeCompletionRunner();
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const channelPath = sessionFilePath(sessionsDir, "+1");
			writeFileSync(channelPath, '{"type":"session"}\n', "utf8");
			const index = new MemoryChannelIndex();
			const store = new MemoryActiveProjectStore();
			store.set("+1", ".."); // hand-edited store value /projects use rejects
			const g = new Gateway({
				transport: s.t,
				index,
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				sessionsDir,
				activeProjects: store,
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "/new", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(existsSync(channelPath)).toBe(false);
			expect(s.sent.some((x) => x.text.includes("started a fresh session"))).toBe(true);
			expect(store.get("+1")).toBeUndefined();
			expect(index.get("+1:..:0")).toBeNull();
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("/new with a stale mapping and no current session clears the mapping and reports nothing to reset", async () => {
		const dir = await home("axiom-gw-new-none-");
		try {
			const s = streamingTransport();
			const completion = fakeCompletionRunner();
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const index = new MemoryChannelIndex();
			const store = new MemoryActiveProjectStore();
			store.set("+1", "alpha"); // no projects/alpha on disk
			const g = new Gateway({
				transport: s.t,
				index,
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				sessionsDir,
				activeProjects: store,
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "/new", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(s.sent.some((x) => x.text.includes("no session to reset"))).toBe(true);
			expect(store.get("+1")).toBeUndefined(); // self-heal happens even with nothing to archive
			expect(index.get("+1:alpha:0")).toBeNull();
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("/new archives the active project's composite session and keeps the mapping", async () => {
		const dir = await home("axiom-gw-new-ok-");
		try {
			const s = streamingTransport();
			const completion = fakeCompletionRunner();
			const sessionsDir = join(dir, "sessions");
			mkdirSync(sessionsDir, { recursive: true });
			await import("node:fs/promises").then((fs) => fs.mkdir(join(dir, "projects", "alpha"), { recursive: true }));
			const anchoredPath = sessionFilePath(sessionsDir, "+1:alpha:0");
			writeFileSync(anchoredPath, '{"type":"session"}\n', "utf8");
			const channelPath = sessionFilePath(sessionsDir, "+1");
			writeFileSync(channelPath, '{"type":"session"}\n', "utf8");
			const index = new MemoryChannelIndex();
			const store = new MemoryActiveProjectStore();
			store.set("+1", "alpha");
			const g = new Gateway({
				transport: s.t,
				index,
				completion,
				axiomHomeDir: dir,
				profile: "default",
				senders: ["+1"],
				sessionsDir,
				activeProjects: store,
			});
			await g.start();
			s.push({ channelId: "+1", sender: "+1", text: "/new", isCommand: true, timestamp: 1 });
			await new Promise((r) => setTimeout(r, 30));
			expect(existsSync(anchoredPath)).toBe(false); // the anchored session is the one /new resets
			expect(existsSync(channelPath)).toBe(true); // the unanchored session is untouched
			expect(store.get("+1")).toBe("alpha"); // a healthy mapping survives /new
			expect(s.sent.some((x) => x.text.includes("started a fresh session"))).toBe(true);
			await g.stop();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
