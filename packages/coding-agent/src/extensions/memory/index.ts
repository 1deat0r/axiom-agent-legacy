/**
 * The axiom memory extension (port #7, ADR-0008 on the pi baseline).
 *
 * Gives the agent a memory it does not have in pi: a `memory` tool
 * (add/remove/list durable facts, user or agent scope) and a
 * `before_agent_start` hook that rides the memory block on the assembled
 * system prompt — memory survives the window by riding the prompt.
 *
 * Dependencies are injectable for tests; defaults use the real file store
 * at `~/.axiom/memory/`, capped at 50 entries per scope (ADR-0008's LRU
 * eviction — memory context costs tokens every turn, so the default is
 * bounded; pass `maxEntriesPerScope: undefined` for unbounded).
 */

import { join } from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { axiomHome } from "../profile/registry.ts";
import { FileMemoryStore, type MemoryScope, type MemoryStore, memoryContextBlock } from "./store.ts";

const DEFAULT_MAX_ENTRIES_PER_SCOPE = 50;

export interface MemoryDeps {
	memoryDir: string;
	maxEntriesPerScope?: number;
	/** Injectable store factory so tests never touch disk. */
	store(dir: string, cap: number | undefined): MemoryStore;
}

const MemoryParamsSchema = Type.Object({
	action: Type.Union([Type.Literal("add"), Type.Literal("remove"), Type.Literal("list")]),
	content: Type.Optional(Type.String()),
	scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("agent")])),
	id: Type.Optional(Type.String()),
});

type MemoryParams = Static<typeof MemoryParamsSchema>;

/** The real-store default, exported so tests can exercise it without IO. */
export function defaultMemoryStore(dir: string, cap: number | undefined): MemoryStore {
	return new FileMemoryStore(dir, { maxEntriesPerScope: cap });
}

export function createMemoryExtension(deps?: Partial<MemoryDeps>): (pi: ExtensionAPI) => void {
	const resolved: MemoryDeps = {
		memoryDir: deps?.memoryDir ?? join(axiomHome(), "memory"),
		maxEntriesPerScope: deps?.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE,
		store: deps?.store ?? defaultMemoryStore,
	};
	return (pi: ExtensionAPI) => {
		const memory = resolved.store(resolved.memoryDir, resolved.maxEntriesPerScope);

		pi.registerTool({
			name: "memory",
			label: "Memory",
			description:
				'Persist or recall durable facts across sessions. Use "add" to remember a stable fact ' +
				'(a user preference, an environment detail, a lesson learned). Use "remove" to forget ' +
				'something stale. Use "list" to see current memory. Prefer declarative facts over ' +
				"task-progress notes.",
			parameters: MemoryParamsSchema,
			execute: async (_toolCallId, params: MemoryParams) => {
				const action = params.action;
				let text: string;
				switch (action) {
					case "add": {
						const content = (params.content ?? "").trim();
						if (!content) throw new Error("action=add requires a non-empty content");
						const scope: MemoryScope = params.scope === "agent" ? "agent" : "user";
						const { entry, evicted } = await memory.add({ scope, content });
						text = `Remembered [${entry.scope}] "${content}" (id: ${entry.id})`;
						if (evicted > 0) {
							// Per-add eviction is at most one entry (before <= cap).
							text += " — evicted 1 stale entry to stay under the cap";
						}
						break;
					}
					case "remove": {
						const id = (params.id ?? "").trim();
						if (!id) throw new Error("action=remove requires an id");
						await memory.remove(id);
						text = `Forgot entry ${id}`;
						break;
					}
					case "list": {
						const entries = await memory.list();
						text =
							entries.length === 0
								? "(memory is empty)"
								: entries.map((e) => `${e.id} [${e.scope}] ${e.content}`).join("\n");
						break;
					}
					default:
						throw new Error(`Unknown memory action: ${action} (expected add|remove|list)`);
				}
				return { content: [{ type: "text", text }], details: null };
			},
		});

		pi.on("before_agent_start", async (event, _ctx) => {
			const block = memoryContextBlock(await memory.list());
			if (block === "") return;
			return { systemPrompt: event.systemPrompt + block };
		});
	};
}

export default function axiomMemoryExtension(pi: ExtensionAPI): void {
	createMemoryExtension()(pi);
}
