import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import axiomLedgerExtension, { createLedgerExtension, defaultLedgerDeps } from "../../src/extensions/ledger/index.ts";
import {
	addTotals,
	aggregateUsage,
	applyOverrides,
	buildCostReport,
	computeLifetime,
	emptyTotals,
	formatUsd,
	type LedgerTotals,
	type OverrideRates,
	priceUsage,
} from "../../src/extensions/ledger/ledger.ts";
import { loadOverrides } from "../../src/extensions/ledger/storage.ts";

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

function assistantEntry(options: {
	provider: string;
	model: string;
	responseModel?: string;
	usage: Usage;
}): SessionEntry {
	const { provider, model, responseModel, usage: u } = options;
	return {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: "2026-08-11T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider,
			model,
			...(responseModel !== undefined ? { responseModel } : {}),
			usage: u,
			stopReason: "stop",
			timestamp: 1,
		},
	} as unknown as SessionEntry;
}

function toolResultEntry(usage: Usage | undefined): SessionEntry {
	return {
		type: "message",
		id: "t1",
		parentId: null,
		timestamp: "2026-08-11T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "bash",
			...(usage !== undefined ? { usage } : {}),
			timestamp: 1,
		},
	} as unknown as SessionEntry;
}

function summaryEntry(kind: "compaction" | "branch_summary", u: Usage | undefined): SessionEntry {
	return {
		type: kind,
		id: "s1",
		parentId: null,
		timestamp: "2026-08-11T00:00:00.000Z",
		...(u ? { usage: u } : {}),
	} as unknown as SessionEntry;
}

function userEntry(): SessionEntry {
	return {
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: "2026-08-11T00:00:00.000Z",
		message: { role: "user", content: "hi", timestamp: 1 },
	} as unknown as SessionEntry;
}

function fakePi() {
	const commands = new Map<string, { description?: string; handler: (a: string, c: unknown) => Promise<void> }>();
	const events = new Map<string, (e: unknown, c: unknown) => Promise<void>>();
	const pi = {
		registerCommand: (
			name: string,
			opts: { description?: string; handler: (a: string, c: unknown) => Promise<void> },
		) => {
			commands.set(name, opts);
		},
		on: (event: string, handler: (e: unknown, c: unknown) => Promise<void>) => {
			events.set(event, handler);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, commands, events };
}

function fakeCtx(entries: SessionEntry[]) {
	const notified: string[] = [];
	const statuses: Array<[string, string | undefined]> = [];
	return {
		ctx: {
			sessionManager: { getEntries: () => entries },
			ui: {
				notify: (message: string) => {
					notified.push(message);
				},
				setStatus: (key: string, text: string | undefined) => {
					statuses.push([key, text]);
				},
			},
		},
		notified,
		statuses,
	};
}

describe("aggregateUsage", () => {
	it("buckets assistant usage by provider/model", () => {
		const u = usage({ input: 100, cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } });
		const buckets = aggregateUsage([assistantEntry({ provider: "deepseek", model: "deepseek-chat", usage: u })]);
		expect(buckets).toEqual([{ key: "deepseek/deepseek-chat", usage: u, recordedCost: 0.001 }]);
	});

	it("uses responseModel when present", () => {
		const u = usage({ output: 50 });
		const buckets = aggregateUsage([
			assistantEntry({
				provider: "openrouter",
				model: "auto",
				responseModel: "anthropic/claude-sonnet-5",
				usage: u,
			}),
		]);
		expect(buckets[0]!.key).toBe("openrouter/anthropic/claude-sonnet-5");
	});

	it("buckets tool results and summaries under Tools/summaries", () => {
		const tr = usage({ input: 10, cost: { input: 0.0002, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0002 } });
		const cs = usage({ output: 5, cost: { input: 0, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0001 } });
		const buckets = aggregateUsage([
			toolResultEntry(tr),
			summaryEntry("compaction", cs),
			summaryEntry("branch_summary", usage({})),
		]);
		expect(buckets.map((b) => b.key)).toEqual(["Tools/summaries"]);
		expect(buckets[0]!.usage.input).toBe(10);
		expect(buckets[0]!.recordedCost).toBeCloseTo(0.0003, 12);
	});

	it("skips entries without usage", () => {
		const buckets = aggregateUsage([userEntry(), toolResultEntry(undefined), summaryEntry("compaction", undefined)]);
		expect(buckets).toEqual([]);
	});

	it("merges repeated keys into one bucket", () => {
		const a = usage({ input: 10 });
		const b = usage({ input: 20 });
		const buckets = aggregateUsage([
			assistantEntry({ provider: "p", model: "m", usage: a }),
			assistantEntry({ provider: "p", model: "m", usage: b }),
		]);
		expect(buckets).toHaveLength(1);
		expect(buckets[0]!.usage.input).toBe(30);
		expect(buckets[0]!.recordedCost).toBe(0);
	});
});

describe("priceUsage", () => {
	const rates: OverrideRates = { input: 1.0, output: 2.0, cacheRead: 0.5, cacheWrite: 1.0 };

	it("prices per-million tokens", () => {
		const u = usage({ input: 1_000_000, output: 500_000, cacheRead: 100_000, cacheWrite: 10_000 });
		const cost = priceUsage(u, rates);
		expect(cost.input).toBe(1.0);
		expect(cost.output).toBe(1.0);
		expect(cost.cacheRead).toBeCloseTo(0.05, 12);
		expect(cost.cacheWrite).toBe(0.01);
		expect(cost.total).toBeCloseTo(2.06, 12);
	});

	it("prices 1h cache writes at 2x the input rate", () => {
		const u = usage({ cacheWrite: 10_000, cacheWrite1h: 4_000 });
		const cost = priceUsage(u, rates);
		expect(cost.cacheWrite).toBeCloseTo(0.006 + 0.008, 12);
		expect(cost.total).toBeCloseTo(0.014, 12);
	});

	it("returns zeros for zero usage", () => {
		const cost = priceUsage(usage({}), rates);
		expect(cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	});
});

describe("applyOverrides", () => {
	it("reprices a bucket when an override matches, with a note", () => {
		const u = usage({
			input: 1_000_000,
			cost: { input: 9.0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9.0 },
		});
		const overrides = new Map([["p/m", { input: 1.0, output: 2.0, cacheRead: 0.5, cacheWrite: 1.0 }]]);
		const { totals, notes } = applyOverrides([{ key: "p/m", usage: u, recordedCost: 9.0 }], overrides);
		expect(totals.cost).toBeCloseTo(1.0, 12);
		expect(notes).toEqual(["p/m repriced at override rates"]);
	});

	it("keeps recorded cost when no override matches", () => {
		const u = usage({ input: 10, cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } });
		const { totals, notes } = applyOverrides([{ key: "p/m", usage: u, recordedCost: 0.001 }], new Map());
		expect(totals.cost).toBe(0.001);
		expect(notes).toEqual([]);
	});

	it("notes zero-cost usage without catalog prices", () => {
		const u = usage({ input: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
		const { totals, notes } = applyOverrides([{ key: "custom/llm", usage: u, recordedCost: 0 }], new Map());
		expect(totals.cost).toBe(0);
		expect(notes).toEqual(["custom/llm: no catalog price (recorded $0.0000)"]);
	});

	it("sums direction splits across buckets", () => {
		const a = usage({
			input: 10,
			output: 20,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		});
		const b = usage({ input: 30, cost: { input: 0.003, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.003 } });
		const { totals } = applyOverrides(
			[
				{ key: "a/x", usage: a, recordedCost: 0.003 },
				{ key: "b/y", usage: b, recordedCost: 0.003 },
			],
			new Map(),
		);
		expect(totals).toEqual({ input: 40, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.006 });
	});
});

describe("totals helpers", () => {
	it("emptyTotals is zero", () => {
		expect(emptyTotals()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
	});

	it("addTotals sums componentwise", () => {
		const a: LedgerTotals = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 };
		const b: LedgerTotals = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 5 };
		expect(addTotals(a, b)).toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44, cost: 5.5 });
	});
});

describe("computeLifetime", () => {
	it("sums buckets across session bundles with overrides applied", () => {
		const u1 = usage({ input: 1_000_000, cost: { input: 9.0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9.0 } });
		const u2 = usage({ output: 500_000, cost: { input: 0, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.05 } });
		const overrides = new Map([["p/m", { input: 1.0, output: 2.0, cacheRead: 0.5, cacheWrite: 1.0 }]]);
		const { totals, notes } = computeLifetime(
			[
				{ path: "s1.jsonl", entries: [assistantEntry({ provider: "p", model: "m", usage: u1 })] },
				{ path: "s2.jsonl", entries: [assistantEntry({ provider: "p", model: "m", usage: u2 })] },
			],
			overrides,
		);
		expect(totals.cost).toBeCloseTo(1.0 + 1.0, 12);
		expect(notes).toEqual(["p/m repriced at override rates"]);
	});

	it("returns zero totals for no bundles", () => {
		const { totals, notes } = computeLifetime([], new Map());
		expect(totals.cost).toBe(0);
		expect(notes).toEqual([]);
	});
});

describe("formatUsd", () => {
	it("formats zero with four decimals", () => {
		expect(formatUsd(0)).toBe("$0.0000");
	});

	it("keeps four decimals in the micro-dollar range", () => {
		expect(formatUsd(0.0042)).toBe("$0.0042");
		expect(formatUsd(0.099999)).toBe("$0.1000");
		expect(formatUsd(0.0001)).toBe("$0.0001");
	});

	it("keeps significant digits below $0.0001", () => {
		expect(formatUsd(0.0000625)).toBe("$0.0000625");
		expect(formatUsd(0.0000042)).toBe("$0.0000042");
	});

	it("formats dollars with two decimals", () => {
		expect(formatUsd(12.3456)).toBe("$12.35");
		expect(formatUsd(1)).toBe("$1.00");
	});
});

describe("buildCostReport", () => {
	it("includes session, lifetime and notes", () => {
		const session: LedgerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.0042 };
		const lifetime: LedgerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.0831 };
		const report = buildCostReport(session, lifetime, ["p/m repriced at override rates"]);
		expect(report).toContain("session $0.0042");
		expect(report).toContain("lifetime $0.0831");
		expect(report).toContain("p/m repriced at override rates");
	});

	it("adds a cap line only when a cap is set", () => {
		const session: LedgerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.0042 };
		const lifetime: LedgerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.0831 };
		const withCap = buildCostReport(session, lifetime, [], { capUsd: 0.5 });
		expect(withCap).toContain("cap $0.50");
		const without = buildCostReport(session, lifetime, []);
		expect(without).not.toContain("cap");
	});

	it("adds per-model rows with an overflow note", () => {
		const session: LedgerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.51 };
		const lifetime: LedgerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.51 };
		const buckets = [
			{ key: "deepseek/deepseek-chat", cost: 0.01 },
			{ key: "openai/gpt-5.6", cost: 0.5 },
		];
		const report = buildCostReport(session, lifetime, [], { buckets });
		expect(report).toContain("deepseek/deepseek-chat $0.0100");
		expect(report).toContain("openai/gpt-5.6 $0.5000");
	});

	it("truncates rows with an explicit overflow note", () => {
		const session: LedgerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 4 };
		const lifetime: LedgerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 4 };
		const buckets = [1, 2, 3, 4, 5].map((n) => ({ key: `model-${n}`, cost: n }));
		const report = buildCostReport(session, lifetime, [], { buckets });
		expect(report).toContain("model-5 $5.00");
		expect(report).toContain("model-4 $4.00");
		expect(report).toContain("model-3 $3.00");
		expect(report).not.toContain("model-2 $");
		expect(report).toContain("+2 more models");
	});
});

describe("loadOverrides", () => {
	it("parses a valid overrides file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-ledger-"));
		try {
			const path = join(dir, "ledger.json");
			await writeFile(
				path,
				JSON.stringify({ overrides: { "p/m": { input: 1.5, output: 3, cacheRead: 0.5, cacheWrite: 1 } } }),
			);
			const map = await loadOverrides(path);
			expect(map.get("p/m")).toEqual({ input: 1.5, output: 3, cacheRead: 0.5, cacheWrite: 1 });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns an empty map for a missing file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-ledger-"));
		try {
			const map = await loadOverrides(join(dir, "nope.json"));
			expect(map.size).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns an empty map for malformed json", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-ledger-"));
		try {
			const path = join(dir, "ledger.json");
			await writeFile(path, "not json");
			const map = await loadOverrides(path);
			expect(map.size).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("skips entries with non-numeric rates", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-ledger-"));
		try {
			const path = join(dir, "ledger.json");
			await writeFile(
				path,
				JSON.stringify({
					overrides: {
						"good/m": { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
						"bad/m": { input: "x", output: 2, cacheRead: 0.5, cacheWrite: 1 },
					},
				}),
			);
			const map = await loadOverrides(path);
			expect(map.has("good/m")).toBe(true);
			expect(map.has("bad/m")).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns an empty map for a non-object document", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-ledger-"));
		try {
			const path = join(dir, "ledger.json");
			await writeFile(path, "null");
			expect((await loadOverrides(path)).size).toBe(0);
			await writeFile(path, "{}");
			expect((await loadOverrides(path)).size).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("skips override values that are not objects", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-ledger-"));
		try {
			const path = join(dir, "ledger.json");
			await writeFile(path, JSON.stringify({ overrides: { "x/m": "nope" } }));
			expect((await loadOverrides(path)).size).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("createLedgerExtension", () => {
	it("registers the /cost command and an agent_settled handler", () => {
		const { pi, commands, events } = fakePi();
		createLedgerExtension()(pi);
		expect(commands.has("cost")).toBe(true);
		expect(events.has("agent_settled")).toBe(true);
	});

	it("the cost handler notifies with session and lifetime spend", async () => {
		const u = usage({ input: 1_000_000, cost: { input: 1.0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.0 } });
		const entries = [assistantEntry({ provider: "deepseek", model: "deepseek-chat", usage: u })];
		const { pi, commands } = fakePi();
		const { ctx, notified } = fakeCtx(entries);
		const deps = {
			overridesPath: "/tmp/ledger.json",
			loadConfig: async () => ({ overrides: new Map<string, OverrideRates>(), maxRunCostUsd: undefined }),
			listAllSessions: async () => [{ path: "/tmp/s1.jsonl" }, { path: "/tmp/s2.jsonl" }],
			loadEntries: () => entries,
		};
		createLedgerExtension(deps)(pi);
		await commands.get("cost")!.handler("", ctx as never);
		expect(notified.join(" ")).toContain("session $1.00");
		expect(notified.join(" ")).toContain("lifetime $2.00");
	});

	it("agent_settled sets a live cost status", async () => {
		const u = usage({ input: 500_000, cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } });
		const entries = [assistantEntry({ provider: "p", model: "m", usage: u })];
		const { pi, events } = fakePi();
		const { ctx, statuses } = fakeCtx(entries);
		const deps = {
			overridesPath: "/tmp/ledger.json",
			loadConfig: async () => ({ overrides: new Map<string, OverrideRates>(), maxRunCostUsd: undefined }),
			listAllSessions: async () => [],
			loadEntries: () => [],
		};
		createLedgerExtension(deps)(pi);
		await events.get("agent_settled")!(null, ctx as never);
		expect(statuses).toContainEqual(["axiom.cost", "$0.5000"]);
	});
});

describe("defaultLedgerDeps", () => {
	it("points at the axiom ledger file and real stores", () => {
		const deps = defaultLedgerDeps();
		expect(deps.overridesPath.endsWith(".axiom/ledger.json")).toBe(true);
		expect(typeof deps.loadConfig).toBe("function");
		expect(typeof deps.listAllSessions).toBe("function");
		expect(typeof deps.loadEntries).toBe("function");
	});

	it("loadOverrides reads a real overrides file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-ledger-"));
		try {
			const path = join(dir, "ledger.json");
			await writeFile(
				path,
				JSON.stringify({ overrides: { "p/m": { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 } } }),
			);
			const config = await defaultLedgerDeps().loadConfig(path);
			const map = config.overrides;
			expect(map.get("p/m")).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("listAllSessions scans the default sessions store", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-ledger-"));
		try {
			vi.stubEnv("PI_CODING_AGENT_DIR", dir);
			const sessions = await defaultLedgerDeps().listAllSessions();
			expect(Array.isArray(sessions)).toBe(true);
			expect(sessions).toHaveLength(0);
		} finally {
			vi.unstubAllEnvs();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("loadEntries narrows a session file to session entries", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-ledger-"));
		try {
			const path = join(dir, "session.jsonl");
			await writeFile(
				path,
				`${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-08-11T00:00:00.000Z", cwd: "/tmp" })}\n${JSON.stringify(
					{
						type: "message",
						id: "m1",
						parentId: null,
						timestamp: "2026-08-11T00:00:00.000Z",
						message: { role: "user", content: "hi", timestamp: 1 },
					},
				)}\n`,
			);
			const entries = defaultLedgerDeps().loadEntries(path);
			expect(entries).toHaveLength(1);
			expect(entries[0]!.type).toBe("message");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("the default export wires the extension with real defaults", () => {
		const { pi, commands, events } = fakePi();
		axiomLedgerExtension(pi);
		expect(commands.has("cost")).toBe(true);
		expect(events.has("agent_settled")).toBe(true);
	});
});
