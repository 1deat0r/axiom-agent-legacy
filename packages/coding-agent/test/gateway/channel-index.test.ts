import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonChannelIndex, MemoryChannelIndex } from "../../src/gateway/channel-index.js";

describe("MemoryChannelIndex", () => {
	it("round-trips get/set/has/remove", () => {
		const i = new MemoryChannelIndex();
		expect(i.has("c1")).toBe(false);
		i.set("c1", "s1");
		expect(i.has("c1")).toBe(true);
		expect(i.get("c1")).toBe("s1");
		i.remove("c1");
		expect(i.get("c1")).toBeNull();
	});
});

describe("JsonChannelIndex", () => {
	it("persists mappings and reloads them", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-"));
		try {
			const a = new JsonChannelIndex(dir);
			a.set("+1", "sess-1");
			const b = new JsonChannelIndex(dir);
			expect(b.get("+1")).toBe("sess-1");
			expect(existsSync(join(dir, "channels.json"))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("recovers from a missing index (self-repairing)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-"));
		try {
			const i = new JsonChannelIndex(dir);
			expect(i.get("nope")).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("removeWhere (composite session cleanup)", () => {
	it("memory: drops only keys matching the predicate", () => {
		const i = new MemoryChannelIndex();
		i.set("c1", "s1");
		i.set("c1:alpha:0", "sa");
		i.set("c1:beta:0", "sb");
		i.set("c2:alpha:0", "sa2");
		i.removeWhere((key) => key.endsWith(":alpha:0"));
		expect(i.get("c1")).toBe("s1");
		expect(i.get("c1:alpha:0")).toBeNull();
		expect(i.get("c1:beta:0")).toBe("sb");
		expect(i.get("c2:alpha:0")).toBeNull();
	});

	it("json: persists the removal across instances", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-rw-"));
		try {
			const a = new JsonChannelIndex(dir);
			a.set("c1", "s1");
			a.set("c1:alpha:0", "sa");
			a.removeWhere((key) => key.includes(":alpha:"));
			const b = new JsonChannelIndex(dir);
			expect(b.get("c1:alpha:0")).toBeNull();
			expect(b.get("c1")).toBe("s1");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
