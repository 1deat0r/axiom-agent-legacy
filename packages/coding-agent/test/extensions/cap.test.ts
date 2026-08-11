import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createLedgerExtension } from "../../src/extensions/ledger/index.ts";
import { bucketFromAssistantMessage, type OverrideRates, shouldBlockRun } from "../../src/extensions/ledger/ledger.ts";
import { loadLedgerConfig, parseCapArg, writeLedgerConfig } from "../../src/extensions/ledger/storage.ts";

function usage(over: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...over,
	};
}

function assistantMessage(options: { provider: string; model: string; responseModel?: string; usage: Usage }) {
	const { provider, model, responseModel, usage: u } = options;
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider,
		model,
		...(responseModel !== undefined ? { responseModel } : {}),
		usage: u,
		stopReason: "stop",
		timestamp: 1,
	};
}

function turnStart(turnIndex = 0) {
	return { type: "turn_start" as const, turnIndex, timestamp: Date.now() };
}

function turnEnd(message: ReturnType<typeof assistantMessage>, turnIndex = 0) {
	return { type: "turn_end" as const, turnIndex, message, toolResults: [] };
}

describe("shouldBlockRun", () => {
	it("never blocks without a cap", () => {
		expect(shouldBlockRun(undefined, 99)).toBe(false);
	});

	it("blocks always when the cap is zero or negative", () => {
		expect(shouldBlockRun(0, 0)).toBe(true);
		expect(shouldBlockRun(0, 0.001)).toBe(true);
		expect(shouldBlockRun(-1, 0)).toBe(true);
	});

	it("blocks only once the run cost reaches the cap", () => {
		expect(shouldBlockRun(0.5, 0)).toBe(false);
		expect(shouldBlockRun(0.5, 0.499)).toBe(false);
		expect(shouldBlockRun(0.5, 0.5)).toBe(true);
		expect(shouldBlockRun(0.5, 0.501)).toBe(true);
	});

	it("a zero-cost run never trips a positive cap", () => {
		expect(shouldBlockRun(0.0001, 0)).toBe(false);
	});
});

describe("bucketFromAssistantMessage", () => {
	it("keys by provider/model and records the usage cost", () => {
		const u = usage({ input: 10, cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } });
		const bucket = bucketFromAssistantMessage(
			assistantMessage({ provider: "deepseek", model: "deepseek-chat", usage: u }),
		);
		expect(bucket.key).toBe("deepseek/deepseek-chat");
		expect(bucket.recordedCost).toBe(0.001);
		expect(bucket.usage.input).toBe(10);
	});

	it("keys by responseModel when present", () => {
		const bucket = bucketFromAssistantMessage(
			assistantMessage({
				provider: "openrouter",
				model: "auto",
				responseModel: "anthropic/claude-sonnet-5",
				usage: usage({}),
			}),
		);
		expect(bucket.key).toBe("openrouter/anthropic/claude-sonnet-5");
	});
});

describe("loadLedgerConfig", () => {
	it("parses overrides and the cap together", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-cap-"));
		try {
			const path = join(dir, "ledger.json");
			await writeFile(
				path,
				JSON.stringify({
					maxRunCostUsd: 0.5,
					overrides: { "p/m": { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 } },
				}),
			);
			const config = await loadLedgerConfig(path);
			expect(config.maxRunCostUsd).toBe(0.5);
			expect(config.overrides.get("p/m")).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("missing file yields no cap and no overrides", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-cap-"));
		try {
			const config = await loadLedgerConfig(join(dir, "nope.json"));
			expect(config.maxRunCostUsd).toBeUndefined();
			expect(config.overrides.size).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("a non-number cap is ignored", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-cap-"));
		try {
			const path = join(dir, "ledger.json");
			await writeFile(path, JSON.stringify({ maxRunCostUsd: "unlimited" }));
			const config = await loadLedgerConfig(path);
			expect(config.maxRunCostUsd).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves a zero cap", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-cap-"));
		try {
			const path = join(dir, "ledger.json");
			await writeFile(path, JSON.stringify({ maxRunCostUsd: 0 }));
			const config = await loadLedgerConfig(path);
			expect(config.maxRunCostUsd).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("parseCapArg", () => {
	it("parses a finite non-negative number", () => {
		expect(parseCapArg("0.5")).toEqual({ kind: "set", usd: 0.5 });
		expect(parseCapArg("0")).toEqual({ kind: "set", usd: 0 });
		expect(parseCapArg("100")).toEqual({ kind: "set", usd: 100 });
	});
	it("parses none as clear", () => {
		expect(parseCapArg("none")).toEqual({ kind: "clear" });
	});
	it("rejects negatives and garbage", () => {
		expect(parseCapArg("-1").kind).toBe("error");
		expect(parseCapArg("abc").kind).toBe("error");
		expect(parseCapArg("NaN").kind).toBe("error");
	});

	it("treats no argument as show", () => {
		expect(parseCapArg("")).toEqual({ kind: "show" });
	});
});

describe("writeLedgerConfig", () => {
	it("writes the cap and preserves overrides", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-cap-"));
		try {
			const path = join(dir, "ledger.json");
			await writeLedgerConfig(path, {
				overrides: new Map([["p/m", { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }]]),
				maxRunCostUsd: 0.5,
			});
			const config = await loadLedgerConfig(path);
			expect(config.maxRunCostUsd).toBe(0.5);
			expect(config.overrides.get("p/m")).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("clearing the cap keeps overrides", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-cap-"));
		try {
			const path = join(dir, "ledger.json");
			await writeLedgerConfig(path, {
				overrides: new Map([["p/m", { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }]]),
				maxRunCostUsd: 0.5,
			});
			await writeLedgerConfig(path, {
				overrides: new Map([["p/m", { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }]]),
			});
			const config = await loadLedgerConfig(path);
			expect(config.maxRunCostUsd).toBeUndefined();
			expect(config.overrides.get("p/m")).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("spend cap in the extension", () => {
	function fakePi() {
		const commands = new Map<string, { handler: (a: string, c: unknown) => Promise<void> }>();
		const events = new Map<string, (e: unknown, c: unknown) => Promise<void>>();
		const pi = {
			registerCommand: (name: string, opts: { handler: (a: string, c: unknown) => Promise<void> }) => {
				commands.set(name, opts);
			},
			on: (event: string, handler: (e: unknown, c: unknown) => Promise<void>) => {
				events.set(event, handler);
			},
		};
		return { pi: pi as unknown as ExtensionAPI, commands, events };
	}

	function fakeCtx() {
		const aborted: string[] = [];
		const notified: string[] = [];
		const statuses: Array<[string, string | undefined]> = [];
		const ctx = {
			sessionManager: { getEntries: () => [] },
			ui: {
				notify: (message: string, _type?: string) => {
					notified.push(message);
				},
				setStatus: (key: string, text: string | undefined) => {
					statuses.push([key, text]);
				},
			},
			abort: () => {
				aborted.push("abort");
			},
		};
		return { ctx, aborted, notified, statuses };
	}

	function depsWith(maxRunCostUsd: number | undefined, overrides: Map<string, OverrideRates> = new Map()) {
		return {
			overridesPath: "/tmp/ledger.json",
			loadConfig: async () => ({ overrides, maxRunCostUsd }),
			listAllSessions: async () => [],
			loadEntries: () => [],
		};
	}

	it("registers the run-lifecycle handlers", () => {
		const { pi, events } = fakePi();
		createLedgerExtension(depsWith(0.5))(pi);
		expect(events.has("agent_start")).toBe(true);
		expect(events.has("turn_start")).toBe(true);
		expect(events.has("turn_end")).toBe(true);
	});

	it("accumulates run spend and aborts when the cap is reached", async () => {
		const { pi, events } = fakePi();
		const { ctx, aborted, notified } = fakeCtx();
		const u1 = usage({ input: 300_000, cost: { input: 0.3, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 } });
		const u2 = usage({ input: 300_000, cost: { input: 0.3, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 } });
		createLedgerExtension(depsWith(0.5))(pi);
		await events.get("agent_start")!(null, ctx as never);
		await events.get("turn_end")!(turnEnd(assistantMessage({ provider: "p", model: "m", usage: u1 })), ctx as never);
		await events.get("turn_start")!(turnStart(1), ctx as never);
		expect(aborted).toEqual([]);
		await events.get("turn_end")!(turnEnd(assistantMessage({ provider: "p", model: "m", usage: u2 })), ctx as never);
		await events.get("turn_start")!(turnStart(2), ctx as never);
		expect(aborted).toEqual(["abort"]);
		expect(notified.some((n) => n.includes("cost cap") && n.includes("run stopped"))).toBe(true);
		expect(
			notified.some((n) => n.toLowerCase().includes("run /cost to review") && n.includes("/cap to adjust")),
		).toBe(true);
	});

	it("resets run spend on agent_start", async () => {
		const { pi, events } = fakePi();
		const { ctx, aborted } = fakeCtx();
		const u = usage({ input: 600_000, cost: { input: 0.6, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.6 } });
		createLedgerExtension(depsWith(0.5))(pi);
		// First run exceeds the cap.
		await events.get("agent_start")!(null, ctx as never);
		await events.get("turn_end")!(turnEnd(assistantMessage({ provider: "p", model: "m", usage: u })), ctx as never);
		await events.get("turn_start")!(turnStart(1), ctx as never);
		expect(aborted).toEqual(["abort"]);
		// A new run starts fresh.
		aborted.length = 0;
		await events.get("agent_start")!(null, ctx as never);
		await events.get("turn_start")!(turnStart(0), ctx as never);
		expect(aborted).toEqual([]);
	});

	it("a zero cap blocks the first turn with a disabled notice", async () => {
		const { pi, events } = fakePi();
		const { ctx, aborted, notified } = fakeCtx();
		createLedgerExtension(depsWith(0))(pi);
		await events.get("agent_start")!(null, ctx as never);
		await events.get("turn_start")!(turnStart(0), ctx as never);
		expect(aborted).toEqual(["abort"]);
		expect(notified.some((n) => n.includes("disabled"))).toBe(true);
		expect(notified.some((n) => n.includes("/cap none to re-enable"))).toBe(true);
	});

	it("applies override repricing to the cap decision", async () => {
		const { pi, events } = fakePi();
		const { ctx, aborted } = fakeCtx();
		// Recorded at $9.00; override reprices to $1.00.
		const u = usage({
			input: 1_000_000,
			cost: { input: 9.0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9.0 },
		});
		const overrides = new Map([["p/m", { input: 1.0, output: 2.0, cacheRead: 0.5, cacheWrite: 1.0 }]]);
		createLedgerExtension(depsWith(5, overrides))(pi);
		await events.get("agent_start")!(null, ctx as never);
		await events.get("turn_end")!(turnEnd(assistantMessage({ provider: "p", model: "m", usage: u })), ctx as never);
		await events.get("turn_start")!(turnStart(1), ctx as never);
		expect(aborted).toEqual([]); // $1.00 repriced < $5 cap
	});

	it("ignores turn ends without assistant usage", async () => {
		const { pi, events } = fakePi();
		const { ctx, aborted } = fakeCtx();
		createLedgerExtension(depsWith(0.5))(pi);
		await events.get("agent_start")!(null, ctx as never);
		// A user-role message and a usage-less assistant message carry no spend.
		await events.get("turn_end")!(
			{ type: "turn_end", turnIndex: 0, message: { role: "user", content: "hi", timestamp: 1 }, toolResults: [] },
			ctx as never,
		);
		// Aborted turns can end with an assistant message that carries no usage.
		const usageLess = {
			...assistantMessage({ provider: "p", model: "m", usage: usage({}) }),
			usage: undefined,
		} as unknown as ReturnType<typeof assistantMessage>;
		await events.get("turn_end")!(turnEnd(usageLess), ctx as never);
		await events.get("turn_start")!(turnStart(1), ctx as never);
		expect(aborted).toEqual([]);
	});

	it("registers the /cap command", () => {
		const { pi, commands } = fakePi();
		createLedgerExtension(depsWith(undefined))(pi);
		expect(commands.has("cap")).toBe(true);
	});

	it("the /cap command shows the cap with session and lifetime headroom", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-cap-"));
		try {
			await writeFile(join(dir, "ledger.json"), JSON.stringify({ maxRunCostUsd: 0.5 }));
			const { pi, commands } = fakePi();
			const { ctx, notified } = fakeCtx();
			const entry = {
				type: "message" as const,
				id: "m1",
				parentId: null,
				timestamp: "2026-08-11T00:00:00.000Z",
				message: {
					role: "assistant" as const,
					content: [],
					api: "openai-completions",
					provider: "p",
					model: "m",
					usage: usage({
						input: 100_000,
						cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
					}),
					stopReason: "stop",
					timestamp: 1,
				},
			} as unknown as import("../../src/core/session-manager.ts").SessionEntry;
			const deps = {
				overridesPath: join(dir, "ledger.json"),
				loadConfig: async () => loadLedgerConfig(join(dir, "ledger.json")),
				listAllSessions: async () => [{ path: join(dir, "s.jsonl") }],
				loadEntries: () => [entry],
			};
			createLedgerExtension(deps)(pi);
			await commands.get("cap")!.handler("", ctx as never);
			expect(notified.join(" ")).toContain("cap $0.50");
			// Session reads the ctx's entries (none here); lifetime scans the bundles.
			expect(notified.join(" ")).toContain("session $0.0000");
			expect(notified.join(" ")).toContain("lifetime $0.1000");
			// Without a cap the show line says so.
			await writeFile(join(dir, "ledger.json"), JSON.stringify({}));
			notified.length = 0;
			await commands.get("cap")!.handler("", ctx as never);
			expect(notified.join(" ")).toContain("no cap");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("the /cap command sets and clears the cap through the config file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-cap-"));
		try {
			const path = join(dir, "ledger.json");
			const { pi, commands } = fakePi();
			const { ctx, notified } = fakeCtx();
			const deps = {
				overridesPath: path,
				loadConfig: async () => loadLedgerConfig(path),
				listAllSessions: async () => [],
				loadEntries: () => [],
			};
			createLedgerExtension(deps)(pi);
			await commands.get("cap")!.handler("1.25", ctx as never);
			expect((await loadLedgerConfig(path)).maxRunCostUsd).toBe(1.25);
			expect(notified.at(-1)).toContain("cap set to $1.25");
			await commands.get("cap")!.handler("none", ctx as never);
			expect((await loadLedgerConfig(path)).maxRunCostUsd).toBeUndefined();
			expect(notified.at(-1)).toContain("cap cleared");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("the /cap command treats zero as disable with a way out", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-cap-"));
		try {
			const path = join(dir, "ledger.json");
			const { pi, commands } = fakePi();
			const { ctx, notified } = fakeCtx();
			const deps = {
				overridesPath: path,
				loadConfig: async () => loadLedgerConfig(path),
				listAllSessions: async () => [],
				loadEntries: () => [],
			};
			createLedgerExtension(deps)(pi);
			await commands.get("cap")!.handler("0", ctx as never);
			expect((await loadLedgerConfig(path)).maxRunCostUsd).toBe(0);
			expect(notified.at(-1)).toContain("LLM calls disabled");
			expect(notified.at(-1)).toContain("/cap none to re-enable");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("the /cap command rejects invalid input", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-cap-"));
		try {
			const path = join(dir, "ledger.json");
			const { pi, commands } = fakePi();
			const { ctx, notified } = fakeCtx();
			const deps = {
				overridesPath: path,
				loadConfig: async () => loadLedgerConfig(path),
				listAllSessions: async () => [],
				loadEntries: () => [],
			};
			createLedgerExtension(deps)(pi);
			await commands.get("cap")!.handler("-1", ctx as never);
			expect(notified.at(-1)).toMatch(/invalid|cap/i);
			expect((await loadLedgerConfig(path)).maxRunCostUsd).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("never blocks when no cap is configured", async () => {
		const { pi, events } = fakePi();
		const { ctx, aborted } = fakeCtx();
		const u = usage({ input: 9_000_000, cost: { input: 9.0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9.0 } });
		createLedgerExtension(depsWith(undefined))(pi);
		await events.get("agent_start")!(null, ctx as never);
		await events.get("turn_end")!(turnEnd(assistantMessage({ provider: "p", model: "m", usage: u })), ctx as never);
		await events.get("turn_start")!(turnStart(1), ctx as never);
		expect(aborted).toEqual([]);
	});
});
