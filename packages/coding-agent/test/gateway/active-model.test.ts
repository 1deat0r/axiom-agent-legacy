import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	activeModelPath,
	FileActiveModelStore,
	InMemoryActiveModelStore,
	parseModelArg,
} from "../../src/gateway/active-model.js";
import { dispatchCommand } from "../../src/gateway/commands/index.js";
import type { GatewayCommandContext } from "../../src/gateway/types.js";

function ctx(store: InMemoryActiveModelStore, profile = "default"): GatewayCommandContext {
	return { profile, axiomHomeDir: "/tmp", projectHome: "/tmp", modelStore: store };
}

describe("parseModelArg", () => {
	it("parses 'provider model'", () => {
		expect(parseModelArg("deepseek deepseek-v4-pro")).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
	});
	it("parses 'provider/model' and 'provider:model' single tokens", () => {
		expect(parseModelArg("deepseek/deepseek-v4-pro")).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
		expect(parseModelArg("deepseek:deepseek-v4-pro")).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
	});
	it("parses a bare model (provider empty -> keep the profile's provider)", () => {
		expect(parseModelArg("deepseek-v4-pro")).toEqual({ provider: "", model: "deepseek-v4-pro" });
	});
	it("returns undefined for empty / whitespace / trailing", () => {
		expect(parseModelArg("")).toBeUndefined();
		expect(parseModelArg("   ")).toBeUndefined();
		expect(parseModelArg("deepseek/")).toBeUndefined();
		expect(parseModelArg("/model")).toBeUndefined();
	});
});

describe("activeModelPath", () => {
	it("is per-profile, filesystem-safe, under <home>/gateway", () => {
		expect(activeModelPath("/x", "default")).toBe(join("/x", "gateway", "model-default.json"));
		expect(activeModelPath("/x", "my profile")).toBe(join("/x", "gateway", "model-my_profile.json"));
	});
});

describe("FileActiveModelStore", () => {
	it("round-trips save/load, clears, and treats a missing file as unset", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-model-"));
		try {
			const path = join(dir, "model-default.json");
			const store = new FileActiveModelStore(path);
			expect(store.load()).toBeUndefined();
			store.save({ provider: "deepseek", model: "deepseek-v4-pro" });
			expect(store.load()).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
			store.clear();
			expect(store.load()).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("round-trips a provider-empty override (bare /model <model>)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-model-"));
		try {
			const path = join(dir, "model-default.json");
			const store = new FileActiveModelStore(path);
			store.save({ provider: "", model: "deepseek-v4-pro" });
			expect(store.load()).toEqual({ provider: "", model: "deepseek-v4-pro" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("clear removes the override file (no {} sediment)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-model-"));
		try {
			const path = join(dir, "model-default.json");
			const store = new FileActiveModelStore(path);
			store.save({ provider: "deepseek", model: "deepseek-v4-pro" });
			store.clear();
			expect(existsSync(path)).toBe(false);
			expect(store.load()).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("/model command", () => {
	it("shows 'not wired' when the gateway lacks a model store", () => {
		const out = dispatchCommand("/model", { profile: "default", axiomHomeDir: "/tmp", projectHome: "/tmp" });
		expect(out).toContain("not wired");
	});
	it("reports read, sets provider+model, persists, and clears", () => {
		const store = new InMemoryActiveModelStore();
		expect(dispatchCommand("/model", ctx(store))).toContain("no model override set");
		const set = dispatchCommand("/model deepseek deepseek-v4-pro", ctx(store));
		expect(set).toContain("model set to deepseek/deepseek-v4-pro");
		expect(store.load()).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
		expect(dispatchCommand("/model", ctx(store))).toContain("active model: deepseek/deepseek-v4-pro");
		expect(dispatchCommand("/model clear", ctx(store))).toContain("cleared");
		expect(store.load()).toBeUndefined();
	});
	it("accepts a single-token provider/model argument", () => {
		const store = new InMemoryActiveModelStore();
		expect(dispatchCommand("/model deepseek/deepseek-v4-pro", ctx(store))).toContain("model set");
		expect(store.load()).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
	});
	it("gives usage on a parse failure", () => {
		const store = new InMemoryActiveModelStore();
		expect(dispatchCommand("/model not a valid model", ctx(store))).toContain("could not parse");
	});
});
