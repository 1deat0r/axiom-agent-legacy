/**
 * Shared acceptance-harness helpers: persona journeys drive the REAL
 * extension defaults (real fs, real env) through fake pi surfaces, so each
 * synthetic user exercises the shipped feature exactly as the CLI would.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createLedgerExtension } from "../../src/extensions/ledger/index.ts";
import { createMemoryExtension } from "../../src/extensions/memory/index.ts";
import { createProfileExtension } from "../../src/extensions/profile/index.ts";
import { AXIOM_HOME_ENV } from "../../src/extensions/profile/registry.ts";

export interface FakePi {
	pi: ExtensionAPI;
	commands: Map<string, { description?: string; handler: (a: string, c: unknown) => Promise<void> }>;
	events: Map<string, Array<(e: unknown, c: unknown) => Promise<unknown>>>;
	tools: Array<{
		name: string;
		execute: (id: string, p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
	}>;
}

/** Run all handlers for an event in registration order, chaining results. */
export async function emitEvent(pi: FakePi, event: string, payload: unknown, ctx: unknown): Promise<unknown> {
	const handlers = pi.events.get(event);
	if (!handlers || handlers.length === 0) return undefined;
	let current = payload;
	for (const handler of handlers) {
		const result = await handler(current, ctx);
		// before_agent_start chaining: the next handler sees the updated prompt.
		if (result && typeof result === "object" && event === "before_agent_start") {
			const r = result as { systemPrompt?: string };
			if (r.systemPrompt !== undefined && typeof current === "object" && current !== null) {
				current = { ...(current as object), systemPrompt: r.systemPrompt };
			}
		}
	}
	return current === payload ? undefined : current;
}

export function fakePi(): FakePi {
	const commands = new Map<string, { description?: string; handler: (a: string, c: unknown) => Promise<void> }>();
	const events = new Map<string, Array<(e: unknown, c: unknown) => Promise<unknown>>>();
	const tools: FakePi["tools"] = [];
	const pi = {
		registerCommand: (
			name: string,
			opts: { description?: string; handler: (a: string, c: unknown) => Promise<void> },
		) => {
			commands.set(name, opts);
		},
		on: (event: string, handler: (e: unknown, c: unknown) => Promise<unknown>) => {
			const list = events.get(event);
			if (list) list.push(handler);
			else events.set(event, [handler]);
		},
		registerTool: (tool: { name: string; execute: (id: string, p: unknown) => Promise<unknown> }) => {
			tools.push(tool as FakePi["tools"][number]);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, commands, events, tools };
}

/** Boot the full axiom surface into one home (env-driven defaults). */
export function bootAxiom(_home: string): FakePi {
	const pi = fakePi();
	createLedgerExtension()(pi.pi);
	createMemoryExtension()(pi.pi);
	createProfileExtension()(pi.pi);
	return pi;
}

export async function tempHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "axiom-user-"));
}

export async function cleanupHome(home: string): Promise<void> {
	await rm(home, { recursive: true, force: true });
}

/** A user-facing interaction context: notify + abort + status + session entries. */
export function userCtx(entries: unknown[] = []) {
	const notified: string[] = [];
	const aborted: string[] = [];
	const statuses: Array<[string, string | undefined]> = [];
	const ctx = {
		sessionManager: { getEntries: () => entries },
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
	return { ctx, notified, aborted, statuses };
}

export function usage(over: Partial<Usage> = {}): Usage {
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

export function assistantMessage(options: { provider: string; model: string; usage: Usage }) {
	const { provider, model, usage: u } = options;
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider,
		model,
		usage: u,
		stopReason: "stop",
		timestamp: 1,
	};
}

export function turnStart(turnIndex = 0) {
	return { type: "turn_start" as const, turnIndex, timestamp: Date.now() };
}

export function turnEnd(message: ReturnType<typeof assistantMessage>, turnIndex = 0) {
	return { type: "turn_end" as const, turnIndex, message, toolResults: [] };
}

export { AXIOM_HOME_ENV };
