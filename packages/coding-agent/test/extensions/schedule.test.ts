import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromAny } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import { ScheduleStore } from "../../src/core/schedule/store.js";
import { SCHEDULE_CHANNEL_ENV, SCHEDULE_SESSION_ENV } from "../../src/core/schedule/types.js";
import { createScheduleExtension } from "../../src/extensions/schedule/index.js";

const NOW = 1_800_000_000_000;

interface Fake {
	pi: ExtensionAPI;
	tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
	ctx: { hasUI: boolean; ui: { notify: (m: string, t?: string) => void } };
}

function fakePi(): Fake {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const ctx = { hasUI: true, ui: { notify: () => {} } };
	const pi = fromAny<ExtensionAPI, unknown>({
		on: () => {},
		registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
			tools.set(t.name, { execute: t.execute }),
	});
	return { pi, tools, ctx };
}

async function tool(fake: Fake, name: string, params: Record<string, unknown>): Promise<string> {
	const t = fake.tools.get(name);
	if (!t) throw new Error(`tool ${name} not registered`);
	const result = fromAny<{ content: Array<{ text: string }> }, unknown>(
		await t.execute("id", params, undefined, undefined, fake.ctx),
	);
	return result.content.map((c) => c.text).join("\n");
}

let dir: string | undefined;
afterEach(() => {
	if (dir) {
		rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	}
	delete process.env[SCHEDULE_CHANNEL_ENV];
	delete process.env[SCHEDULE_SESSION_ENV];
});
function scratch(): string {
	dir = mkdtempSync(join(tmpdir(), "schedule-ext-"));
	return dir;
}

describe("createScheduleExtension", () => {
	it("is inert without the gateway channel and session tags", () => {
		const fake = fakePi();
		createScheduleExtension({})(fake.pi);
		expect(fake.tools.size).toBe(0);
	});

	it("is inert with only a channel tag", () => {
		const fake = fakePi();
		createScheduleExtension({ channelId: "+1" })(fake.pi);
		expect(fake.tools.size).toBe(0);
	});

	it("reads the gateway tags from the environment", () => {
		process.env[SCHEDULE_CHANNEL_ENV] = "+9";
		process.env[SCHEDULE_SESSION_ENV] = "gw-abc";
		const fake = fakePi();
		createScheduleExtension({ homeDir: scratch() })(fake.pi);
		expect([...fake.tools.keys()].sort()).toEqual(["schedule_after", "schedule_at", "schedule_every"]);
	});

	it("registers three tools when the gateway tags the run", () => {
		const fake = fakePi();
		createScheduleExtension({ channelId: "+1", sessionId: "gw-abc", homeDir: scratch() })(fake.pi);
		expect([...fake.tools.keys()].sort()).toEqual(["schedule_after", "schedule_at", "schedule_every"]);
	});

	it("schedule_after stores a reminder due after the delay", async () => {
		const storePath = join(scratch(), "gateway", "schedule.jsonl");
		const fake = fakePi();
		createScheduleExtension({
			channelId: "+1",
			sessionId: "gw-abc",
			storePath,
			now: () => NOW,
			uuid: () => "id-1",
		})(fake.pi);
		const out = await tool(fake, "schedule_after", { delay: "30m", text: "check the oven" });
		expect(out).toContain("check the oven");
		const reminders = new ScheduleStore(storePath).read();
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toMatchObject({
			id: "id-1",
			kind: "after",
			channelId: "+1",
			sessionId: "gw-abc",
			dueAt: NOW + 1_800_000,
			text: "check the oven",
		});
		expect(reminders[0]?.intervalMs).toBeUndefined();
	});

	it("schedule_after rejects a zero or malformed delay and stores nothing", async () => {
		const storePath = join(scratch(), "gateway", "schedule.jsonl");
		const fake = fakePi();
		createScheduleExtension({ channelId: "+1", sessionId: "gw-abc", storePath, now: () => NOW, uuid: () => "id-x" })(
			fake.pi,
		);
		expect(await tool(fake, "schedule_after", { delay: "0m", text: "x" })).toContain("positive");
		expect(await tool(fake, "schedule_after", { delay: "later", text: "x" })).toContain("duration");
		expect(new ScheduleStore(storePath).read()).toHaveLength(0);
	});

	it("schedule_at stores an absolute instant and rejects past or zone-less instants", async () => {
		const storePath = join(scratch(), "gateway", "schedule.jsonl");
		const fake = fakePi();
		createScheduleExtension({ channelId: "+1", sessionId: "gw-abc", storePath, now: () => NOW, uuid: () => "id-2" })(
			fake.pi,
		);
		const out = await tool(fake, "schedule_at", { instant: "2027-02-01T00:00:00Z", text: "standup" });
		expect(out).toContain("standup");
		const reminders = new ScheduleStore(storePath).read();
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toMatchObject({ kind: "at", dueAt: Date.parse("2027-02-01T00:00:00Z"), text: "standup" });
		expect(await tool(fake, "schedule_at", { instant: "2020-01-01T00:00:00Z", text: "past" })).toContain("future");
		expect(await tool(fake, "schedule_at", { instant: "2027-02-01T00:00:00", text: "zoneless" })).toContain("zone");
		expect(new ScheduleStore(storePath).read()).toHaveLength(1);
	});

	it("schedule_every stores a repeating reminder and rejects intervals under five minutes", async () => {
		const storePath = join(scratch(), "gateway", "schedule.jsonl");
		const fake = fakePi();
		createScheduleExtension({ channelId: "+1", sessionId: "gw-abc", storePath, now: () => NOW, uuid: () => "id-3" })(
			fake.pi,
		);
		const out = await tool(fake, "schedule_every", { interval: "10m", text: "stretch" });
		expect(out).toContain("stretch");
		const reminders = new ScheduleStore(storePath).read();
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toMatchObject({ kind: "every", dueAt: NOW + 600_000, intervalMs: 600_000, text: "stretch" });
		expect(await tool(fake, "schedule_every", { interval: "4m", text: "too often" })).toContain("at least 5m");
		expect(new ScheduleStore(storePath).read()).toHaveLength(1);
	});

	it("rejects empty or oversized reminder text", async () => {
		const storePath = join(scratch(), "gateway", "schedule.jsonl");
		const fake = fakePi();
		createScheduleExtension({ channelId: "+1", sessionId: "gw-abc", storePath, now: () => NOW, uuid: () => "id-4" })(
			fake.pi,
		);
		expect(await tool(fake, "schedule_after", { delay: "5m", text: "   " })).toContain("empty");
		expect(await tool(fake, "schedule_after", { delay: "5m", text: "x".repeat(4001) })).toContain("4000");
		expect(new ScheduleStore(storePath).read()).toHaveLength(0);
	});
});
