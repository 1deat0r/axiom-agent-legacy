import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import axiomMemoryExtension, { createMemoryExtension } from "../../src/extensions/memory/index.ts";
import {
	FileMemoryStore,
	InMemoryMemoryStore,
	type MemoryEntry,
	type MemoryStore,
	memoryContextBlock,
} from "../../src/extensions/memory/store.ts";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "axiom-memory-"));
}

async function readScope(dir: string, scope: "user" | "agent"): Promise<MemoryEntry[]> {
	return JSON.parse(await readFile(join(dir, `${scope}.json`), "utf8")) as MemoryEntry[];
}

describe("FileMemoryStore", () => {
	it("adds and lists entries newest-first with the user scope default", async () => {
		const dir = await tempDir();
		try {
			const store = new FileMemoryStore(dir);
			await store.add({ scope: "user", content: "User likes concise answers" });
			await store.add({ scope: "agent", content: "This repo uses node:test" });
			const all = await store.list();
			expect(all.map((e) => e.content)).toEqual(["This repo uses node:test", "User likes concise answers"]);
			expect((await store.list("user")).map((e) => e.content)).toEqual(["User likes concise answers"]);
			expect(all.every((e) => e.id && e.createdAt > 0 && e.updatedAt >= e.createdAt)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("persists per-scope JSON files", async () => {
		const dir = await tempDir();
		try {
			const store = new FileMemoryStore(dir);
			await store.add({ scope: "user", content: "fact" });
			const onDisk = await readScope(dir, "user");
			expect(onDisk).toHaveLength(1);
			expect(onDisk[0]!.content).toBe("fact");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns an empty list for a missing directory", async () => {
		const dir = await tempDir();
		try {
			const store = new FileMemoryStore(join(dir, "nope"));
			expect(await store.list()).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("updates content and bumps updatedAt", async () => {
		const dir = await tempDir();
		try {
			const store = new FileMemoryStore(dir);
			const { entry } = await store.add({ scope: "user", content: "old" });
			const updated = await store.update(entry.id, "new");
			expect(updated.content).toBe("new");
			expect(updated.updatedAt).toBeGreaterThanOrEqual(entry.updatedAt);
			expect((await store.list())[0]!.content).toBe("new");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("throws on updating an unknown id", async () => {
		const dir = await tempDir();
		try {
			const store = new FileMemoryStore(dir);
			await expect(store.update("missing", "x")).rejects.toThrow("not found");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("removes by id", async () => {
		const dir = await tempDir();
		try {
			const store = new FileMemoryStore(dir);
			const a = (await store.add({ scope: "user", content: "a" })).entry;
			const b = (await store.add({ scope: "user", content: "b" })).entry;
			await store.remove(a.id);
			expect((await store.list()).map((e) => e.content)).toEqual(["b"]);
			await store.remove(b.id);
			expect(await store.list()).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("evicts the least-recently-updated entries per scope on add", async () => {
		const dir = await tempDir();
		try {
			const store = new FileMemoryStore(dir, { maxEntriesPerScope: 2 });
			const a = (await store.add({ scope: "user", content: "a" })).entry;
			await store.add({ scope: "user", content: "b" });
			await store.add({ scope: "user", content: "c" });
			expect((await store.list("user")).map((e) => e.content)).toEqual(["c", "b"]);
			// Touching a surviving entry makes it beat the next eviction.
			const d = (await store.add({ scope: "user", content: "d" })).entry;
			await store.update(d.id, "d2");
			await store.add({ scope: "user", content: "e" });
			expect((await store.list("user")).map((e) => e.content)).toEqual(["e", "d2"]);
			// The evicted entry is gone for good.
			await expect(store.update(a.id, "a2")).rejects.toThrow("not found");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps user and agent caps independent", async () => {
		const dir = await tempDir();
		try {
			const store = new FileMemoryStore(dir, { maxEntriesPerScope: 1 });
			await store.add({ scope: "user", content: "user fact" });
			await store.add({ scope: "agent", content: "agent fact" });
			await store.add({ scope: "agent", content: "agent fact 2" });
			expect((await store.list("user")).map((e) => e.content)).toEqual(["user fact"]);
			expect((await store.list("agent")).map((e) => e.content)).toEqual(["agent fact 2"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("is unbounded without a cap", async () => {
		const dir = await tempDir();
		try {
			const store = new FileMemoryStore(dir);
			for (let i = 0; i < 5; i++) await store.add({ scope: "user", content: `fact ${i}` });
			expect(await store.list("user")).toHaveLength(5);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("assigns strictly monotonic timestamps", async () => {
		const dir = await tempDir();
		try {
			const store = new FileMemoryStore(dir);
			const a = (await store.add({ scope: "user", content: "a" })).entry;
			const b = (await store.add({ scope: "user", content: "b" })).entry;
			const c = (await store.add({ scope: "user", content: "c" })).entry;
			expect(a.updatedAt).toBeLessThan(b.updatedAt);
			expect(b.updatedAt).toBeLessThan(c.updatedAt);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("treats a non-array scope file as empty", async () => {
		const dir = await tempDir();
		try {
			await mkdir(dir, { recursive: true });
			const { writeFile } = await import("node:fs/promises");
			await writeFile(join(dir, "user.json"), "{}");
			const store = new FileMemoryStore(dir);
			expect(await store.list("user")).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("removes entries from the agent scope too", async () => {
		const dir = await tempDir();
		try {
			const store = new FileMemoryStore(dir);
			const a = (await store.add({ scope: "agent", content: "agent note" })).entry;
			await store.add({ scope: "user", content: "user note" });
			await store.remove(a.id);
			expect(await store.list("agent")).toEqual([]);
			expect(await store.list("user")).toHaveLength(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects corrupt scope files with a throw", async () => {
		const dir = await tempDir();
		try {
			await mkdir(dir, { recursive: true });
			const { writeFile } = await import("node:fs/promises");
			await writeFile(join(dir, "user.json"), "not json");
			const store = new FileMemoryStore(dir);
			await expect(store.list()).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("InMemoryMemoryStore", () => {
	it("supports add, list (newest-first), update and remove", async () => {
		const store = new InMemoryMemoryStore();
		const { entry } = await store.add({ scope: "user", content: "fact" });
		await store.add({ scope: "user", content: "fact 2" });
		expect((await store.list()).map((e) => e.content)).toEqual(["fact 2", "fact"]);
		await store.update(entry.id, "fact 1");
		expect((await store.list("user"))[0]!.content).toBe("fact 1");
		await store.remove(entry.id);
		expect((await store.list()).map((e) => e.content)).toEqual(["fact 2"]);
	});

	it("reports how many entries an add evicted", async () => {
		const store = new FileMemoryStore(await tempDir(), { maxEntriesPerScope: 2 });
		expect((await store.add({ scope: "user", content: "a" })).evicted).toBe(0);
		expect((await store.add({ scope: "user", content: "b" })).evicted).toBe(0);
		expect((await store.add({ scope: "user", content: "c" })).evicted).toBe(1);
		expect((await store.add({ scope: "user", content: "d" })).evicted).toBe(1);
	});

	it("the in-memory store reports evictions the same way", async () => {
		const store = new InMemoryMemoryStore({ maxEntriesPerScope: 1 });
		expect((await store.add({ scope: "user", content: "a" })).evicted).toBe(0);
		expect((await store.add({ scope: "user", content: "b" })).evicted).toBe(1);
	});

	it("throws on updating an unknown id", async () => {
		const store = new InMemoryMemoryStore();
		await expect(store.update("missing", "x")).rejects.toThrow("not found");
	});

	it("evicts per scope on add when capped", async () => {
		const store = new InMemoryMemoryStore({ maxEntriesPerScope: 1 });
		await store.add({ scope: "user", content: "u1" });
		await store.add({ scope: "agent", content: "a1" });
		await store.add({ scope: "user", content: "u2" });
		expect((await store.list("user")).map((e) => e.content)).toEqual(["u2"]);
		expect((await store.list("agent")).map((e) => e.content)).toEqual(["a1"]);
	});
});

describe("memoryContextBlock", () => {
	it("returns empty for no entries", () => {
		expect(memoryContextBlock([])).toBe("");
	});

	it("renders a delimited block with scope prefixes", () => {
		const block = memoryContextBlock([
			{ id: "1", scope: "user", content: "User prefers x", createdAt: 1, updatedAt: 1 },
			{ id: "2", scope: "agent", content: "Repo uses y", createdAt: 2, updatedAt: 2 },
		]);
		expect(block).toContain("<<<memory>>>");
		expect(block).toContain("- [user] User prefers x");
		expect(block).toContain("- [agent] Repo uses y");
		expect(block).toContain("<</memory>>>");
	});
});

describe("createMemoryExtension", () => {
	function fakePi() {
		const tools: Array<{
			name: string;
			label: string;
			description: string;
			execute?: (id: string, p: unknown) => Promise<unknown>;
		}> = [];
		const events = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
		const pi = {
			registerTool: (tool: {
				name: string;
				label: string;
				description: string;
				execute: (id: string, p: unknown) => Promise<unknown>;
			}) => {
				tools.push(tool);
			},
			on: (event: string, handler: (e: unknown, c: unknown) => Promise<unknown>) => {
				events.set(event, handler);
			},
		};
		return { pi: pi as unknown as ExtensionAPI, tools, events };
	}

	function depsWith(store: MemoryStore) {
		return { memoryDir: "/tmp/memory", store: () => store };
	}

	it("registers the memory tool and the context hook", () => {
		const { pi, tools, events } = fakePi();
		createMemoryExtension(depsWith(new InMemoryMemoryStore()))(pi);
		expect(tools.some((t) => t.name === "memory")).toBe(true);
		expect(events.has("before_agent_start")).toBe(true);
	});

	it("injects the memory block into the system prompt", async () => {
		const { pi, events } = fakePi();
		const store = new InMemoryMemoryStore();
		await store.add({ scope: "user", content: "User prefers concise answers" });
		createMemoryExtension(depsWith(store))(pi);
		const result = await events.get("before_agent_start")!(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			null,
		);
		expect((result as { systemPrompt?: string }).systemPrompt).toContain("base");
		expect((result as { systemPrompt?: string }).systemPrompt).toContain("- [user] User prefers concise answers");
	});

	it("leaves the system prompt alone when memory is empty", async () => {
		const { pi, events } = fakePi();
		createMemoryExtension(depsWith(new InMemoryMemoryStore()))(pi);
		const result = await events.get("before_agent_start")!(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			null,
		);
		expect(result).toBeUndefined();
	});

	it("the tool adds, lists and removes facts", async () => {
		const { pi, tools } = fakePi();
		const store = new InMemoryMemoryStore();
		createMemoryExtension(depsWith(store))(pi);
		const tool = tools.find((t) => t.name === "memory")!;
		const added = (await tool.execute!("c1", { action: "add", content: "User likes tea", scope: "user" })) as {
			content: Array<{ type: string; text: string }>;
		};
		expect(added.content[0]!.text).toContain("Remembered [user]");
		expect(added.content[0]!.text).not.toContain("evicted");
		const listed = (await tool.execute!("c2", { action: "list" })) as {
			content: Array<{ type: string; text: string }>;
		};
		expect(listed.content[0]!.text).toContain("[user] User likes tea");
		const removed = (await tool.execute!("c3", { action: "remove", id: (await store.list())[0]!.id })) as {
			content: Array<{ type: string; text: string }>;
		};
		expect(removed.content[0]!.text).toContain("Forgot");
		expect(await store.list()).toEqual([]);
	});

	it("every over-cap add names the eviction", async () => {
		const { pi, tools } = fakePi();
		const store = new InMemoryMemoryStore({ maxEntriesPerScope: 1 });
		createMemoryExtension({ memoryDir: "/tmp/memory", maxEntriesPerScope: 1, store: () => store })(pi);
		const tool = tools.find((t) => t.name === "memory")!;
		await tool.execute!("c1", { action: "add", content: "a", scope: "user" });
		await tool.execute!("c2", { action: "add", content: "b", scope: "user" });
		// Each over-cap add evicts exactly one stale entry (per-add eviction <= 1).
		const third = (await tool.execute!("c3", { action: "add", content: "c", scope: "user" })) as {
			content: Array<{ type: string; text: string }>;
		};
		expect(third.content[0]!.text).toContain("evicted 1 stale entry");
		const fourth = (await tool.execute!("c4", { action: "add", content: "d", scope: "user" })) as {
			content: Array<{ type: string; text: string }>;
		};
		expect(fourth.content[0]!.text).toContain("evicted 1 stale entry");
	});

	it("the add result names evicted entries under the cap", async () => {
		const { pi, tools } = fakePi();
		const store = new InMemoryMemoryStore({ maxEntriesPerScope: 2 });
		createMemoryExtension({ memoryDir: "/tmp/memory", maxEntriesPerScope: 2, store: () => store })(pi);
		const tool = tools.find((t) => t.name === "memory")!;
		await tool.execute!("c1", { action: "add", content: "a", scope: "user" });
		await tool.execute!("c2", { action: "add", content: "b", scope: "user" });
		const third = (await tool.execute!("c3", { action: "add", content: "c", scope: "user" })) as {
			content: Array<{ type: string; text: string }>;
		};
		expect(third.content[0]!.text).toContain("evicted 1 stale");
	});

	it("defaults to the user scope and rejects bad input", async () => {
		const { pi, tools } = fakePi();
		const store = new InMemoryMemoryStore();
		createMemoryExtension(depsWith(store))(pi);
		const tool = tools.find((t) => t.name === "memory")!;
		await tool.execute!("c1", { action: "add", content: "agent note", scope: "agent" });
		expect((await store.list())[0]!.scope).toBe("agent");
		await expect(tool.execute!("c2", { action: "add" })).rejects.toThrow("non-empty content");
		await expect(tool.execute!("c3", { action: "explode" })).rejects.toThrow("Unknown memory action");
		await expect(tool.execute!("c4", { action: "remove" })).rejects.toThrow("requires an id");
	});

	it("the default export wires real defaults", () => {
		const { pi, tools, events } = fakePi();
		axiomMemoryExtension(pi);
		expect(tools.some((t) => t.name === "memory")).toBe(true);
		expect(events.has("before_agent_start")).toBe(true);
	});

	it("lists an empty store as the empty message", async () => {
		const { pi, tools } = fakePi();
		createMemoryExtension(depsWith(new InMemoryMemoryStore()))(pi);
		const tool = tools.find((t) => t.name === "memory")!;
		const result = (await tool.execute!("c1", { action: "list" })) as {
			content: Array<{ type: string; text: string }>;
		};
		expect(result.content[0]!.text).toBe("(memory is empty)");
	});
});
