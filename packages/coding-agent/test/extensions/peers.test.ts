import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import { listPeers, resolvePeerScopeDir } from "../../src/core/peers/index.js";
import { resolveInstanceId } from "../../src/core/peers/instance-id.js";
import { createPeersExtension } from "../../src/extensions/peers/index.js";

const NOW = 1_800_000_000_000;
let uuidCounter = 0;

interface Fake {
	pi: ExtensionAPI;
	tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
	notify: Array<{ message: string; type?: string }>;
	ctx: { hasUI: boolean; ui: { notify: (m: string, t?: string) => void } };
}

function fakePi(): Fake {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const notify: Fake["notify"] = [];
	const ctx = { hasUI: true, ui: { notify: (m: string, t?: string) => notify.push({ message: m, type: t }) } };
	const pi = {
		on: (evt: string, h: (...args: unknown[]) => unknown) => handlers.set(evt, [...(handlers.get(evt) ?? []), h]),
		registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
			tools.set(t.name, { execute: t.execute }),
	} as unknown as ExtensionAPI;
	return { pi, tools, handlers, notify, ctx };
}

async function fire(
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>,
	evt: string,
	event: unknown,
	ctx: unknown,
): Promise<void> {
	for (const h of handlers.get(evt) ?? []) await h(event, ctx);
}

async function tool(fake: Fake, name: string, params: Record<string, unknown>): Promise<string> {
	const t = fake.tools.get(name);
	if (!t) throw new Error(`tool ${name} not registered`);
	const result = (await t.execute("id", params, undefined, undefined, fake.ctx)) as {
		content: Array<{ text: string }>;
	};
	return result.content.map((c) => c.text).join("\n");
}

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "peers-ext-"));
}

describe("createPeersExtension", () => {
	it("is inert without a project root", () => {
		const fake = fakePi();
		createPeersExtension({})(fake.pi);
		expect(fake.tools.size).toBe(0);
	});

	it("registers four tools when anchored", () => {
		const project = scratch();
		const scope = scratch();
		try {
			const fake = fakePi();
			createPeersExtension({ root: project, scope })(fake.pi);
			expect([...fake.tools.keys()].sort()).toEqual(["peers_inbox", "peers_intent", "peers_list", "peers_send"]);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(scope, { recursive: true, force: true });
		}
	});

	it("two anchored extensions coordinate: send, group chat, inbox, intent", async () => {
		const homeA = scratch();
		const homeB = scratch();
		const homeC = scratch();
		const s = scratch();
		const fakeA = fakePi();
		const fakeB = fakePi();
		const fakeC = fakePi();
		const project = scratch();
		try {
			createPeersExtension({
				root: project,
				homeDir: homeA,
				scope: s,
				uuid: () => `run-a-${uuidCounter++}`,
				now: () => NOW,
			})(fakeA.pi);
			createPeersExtension({
				root: project,
				homeDir: homeB,
				scope: s,
				uuid: () => `run-b-${uuidCounter++}`,
				now: () => NOW,
			})(fakeB.pi);
			createPeersExtension({
				root: project,
				homeDir: homeC,
				scope: s,
				uuid: () => `run-c-${uuidCounter++}`,
				now: () => NOW,
			})(fakeC.pi);

			const idB = resolveInstanceId(homeB).instanceId;

			// registration happens on session_start
			for (const fake of [fakeA, fakeB, fakeC])
				await fire(fake.handlers, "session_start", { reason: "startup" }, fake.ctx);

			const listText = await tool(fakeA, "peers_list", {});
			expect(listText).toContain("active");

			// directed message
			await tool(fakeA, "peers_send", { to: idB, text: "please hold off on commits" });
			const inboxB = await tool(fakeB, "peers_inbox", {});
			expect(inboxB).toContain("please hold off on commits");

			// group chat reaches the third peer too
			await tool(fakeA, "peers_send", { to: "*", text: "group: daily sync at 10" });
			expect(await tool(fakeB, "peers_inbox", {})).toContain("group: daily sync at 10");
			expect(await tool(fakeC, "peers_inbox", {})).toContain("group: daily sync at 10");

			// intent is visible
			await tool(fakeB, "peers_intent", { text: "on branch feat/y in .worktrees/y" });
			const list = await tool(fakeA, "peers_list", {});
			expect(list).toContain("on branch feat/y in .worktrees/y");
		} finally {
			rmSync(homeA, { recursive: true, force: true });
			rmSync(homeB, { recursive: true, force: true });
			rmSync(homeC, { recursive: true, force: true });
			rmSync(s, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});

	it("turn_start notifies when unread messages exist and clears presence on shutdown", async () => {
		const homeA = scratch();
		const homeB = scratch();
		const s = scratch();
		const fakeA = fakePi();
		const fakeB = fakePi();
		const project = scratch();
		try {
			createPeersExtension({
				root: project,
				homeDir: homeA,
				scope: s,
				uuid: () => `run-a-${uuidCounter++}`,
				now: () => NOW,
			})(fakeA.pi);
			createPeersExtension({
				root: project,
				homeDir: homeB,
				scope: s,
				uuid: () => `run-b-${uuidCounter++}`,
				now: () => NOW,
			})(fakeB.pi);
			await fire(fakeA.handlers, "session_start", { reason: "startup" }, fakeA.ctx);
			await fire(fakeB.handlers, "session_start", { reason: "startup" }, fakeB.ctx);

			const idB = resolveInstanceId(homeB).instanceId;
			await tool(fakeA, "peers_send", { to: idB, text: "wake up" });
			await fire(fakeB.handlers, "turn_start", { turnIndex: 1, timestamp: NOW }, fakeB.ctx);
			expect(fakeB.notify.some((n) => n.message.includes("peer"))).toBe(true);

			const before = listPeers(s, resolveInstanceId(homeB));
			expect(before.active.length + before.stale.length + before.self.length).toBeGreaterThan(0);
			await fire(fakeB.handlers, "session_shutdown", { reason: "quit" }, fakeB.ctx);
			const after = listPeers(s, resolveInstanceId(homeB));
			expect(after.self).toHaveLength(0);
		} finally {
			rmSync(homeA, { recursive: true, force: true });
			rmSync(homeB, { recursive: true, force: true });
			rmSync(s, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});

	it("resolves scope from project root and home", () => {
		const project = scratch();
		const home = scratch();
		try {
			const resolved = resolvePeerScopeDir(project, home);
			expect(resolved).toMatch(new RegExp(`^${join(home, "peers")}/[0-9a-f]{12}$`));
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});
