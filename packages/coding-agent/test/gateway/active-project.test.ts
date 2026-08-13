import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import {
	FileActiveProjectStore,
	MemoryActiveProjectStore,
	resolveProjectRoot,
} from "../../src/gateway/active-project.js";

describe("MemoryActiveProjectStore", () => {
	it("tracks an active project per channel and clears it", () => {
		const s = new MemoryActiveProjectStore();
		expect(s.get("+1")).toBeUndefined();
		s.set("+1", "alpha");
		s.set("+2", "beta");
		expect(s.get("+1")).toBe("alpha");
		expect(s.get("+2")).toBe("beta");
		s.clear("+1");
		expect(s.get("+1")).toBeUndefined();
		expect(s.get("+2")).toBe("beta");
	});

	it("starts every project at generation 0 and bumps it on removeProject", () => {
		const s = new MemoryActiveProjectStore();
		expect(s.generation("alpha")).toBe(0);
		s.set("+1", "alpha");
		s.removeProject("alpha");
		expect(s.generation("alpha")).toBe(1);
		expect(s.get("+1")).toBeUndefined();
		// Only the removed project's mapping dies.
		s.set("+2", "beta");
		s.removeProject("alpha");
		expect(s.get("+2")).toBe("beta");
		expect(s.generation("beta")).toBe(0);
	});

	it("removeProject bumps the generation even with no active channels", () => {
		const s = new MemoryActiveProjectStore();
		s.removeProject("alpha");
		expect(s.generation("alpha")).toBe(1);
	});
});

describe("FileActiveProjectStore", () => {
	it("persists channel mappings and generations across instances", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-actproj-"));
		try {
			const a = new FileActiveProjectStore(dir);
			a.set("+1", "alpha");
			a.set("+2", "beta");
			a.removeProject("alpha");
			// A fresh instance sees the persisted state.
			const b = new FileActiveProjectStore(dir);
			expect(b.get("+1")).toBeUndefined(); // cleared by removeProject
			expect(b.get("+2")).toBe("beta");
			expect(b.generation("alpha")).toBe(1);
			expect(b.generation("beta")).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("self-heals a malformed or missing store file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-actproj-"));
		try {
			await writeFile(join(dir, "active-projects.json"), "{not json", "utf8");
			const s = new FileActiveProjectStore(dir);
			expect(s.get("+1")).toBeUndefined();
			expect(s.generation("alpha")).toBe(0);
			s.set("+1", "alpha");
			expect(s.get("+1")).toBe("alpha");
			const raw = fromPartial<{
				channels: Record<string, string>;
				generations: Record<string, number>;
			}>(JSON.parse(await readFile(join(dir, "active-projects.json"), "utf8")));
			expect(raw.channels["+1"]).toBe("alpha");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveProjectRoot", () => {
	it("joins the profile home with the projects dir and the project name", () => {
		expect(resolveProjectRoot("/home/w", "alpha")).toBe("/home/w/projects/alpha");
	});
});
