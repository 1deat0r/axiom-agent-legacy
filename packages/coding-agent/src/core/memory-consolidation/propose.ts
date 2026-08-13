/**
 * The model-driven proposal pass: review a completed session and extract
 * durable facts as JSON. Purely a producer — it never writes anything. The
 * deterministic gate (gate.ts) decides what survives, and apply.ts/staging
 * decide where it lands. Mirrors planRefinement's call shape (completeSimple +
 * extractJsonObject) so the consolidation pass reuses the same battle-tested
 * JSON recovery as /refine.
 */

import type { Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import { extractJsonObject } from "../refinement/index.js";
import type { ConsolidationProposal, ConsolidationRequest, MemoryFact } from "./types.js";

export const CONSOLIDATION_SYSTEM_PROMPT = `You are Axiom's memory-consolidation subsystem.

Review the completed agent session and extract durable facts worth remembering in future sessions.
A durable fact is: a stable user preference, a tool/environment fact, a decision, a lesson learned, or a project-specific convention. It is NOT task progress, transient state, current blockers, to-dos, or anything that only matters this session.
Existing memories are listed for deduplication: never propose a fact already covered there, and never propose facts that merely restate the task itself.
Write compact, specific entries. Return JSON only with this exact shape:

{
  "summary": "one sentence about what was consolidated",
  "rationale": "why these facts are durable and useful across sessions",
  "facts": [
    {"title": "short label", "content": "the durable fact", "path": "optional grouping path"}
  ]
}

Return an empty facts array when nothing durable is worth keeping.`;

const CONSOLIDATION_MAX_OUTPUT_TOKENS = 16_000;

export function consolidationMaxOutputTokens(model: Model<any>): number {
	return Math.min(model.maxTokens, CONSOLIDATION_MAX_OUTPUT_TOKENS);
}

/** Parse a consolidation JSON reply into a validated proposal. */
export function parseConsolidationResponse(text: string): ConsolidationProposal {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Consolidation JSON must be an object");
	}
	const record = value as Record<string, unknown>;
	const facts: MemoryFact[] = [];
	if (record.facts !== undefined && !Array.isArray(record.facts)) {
		throw new Error("Consolidation facts must be an array");
	}
	if (Array.isArray(record.facts)) {
		for (const raw of record.facts) {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
			const fact = raw as Record<string, unknown>;
			const title = typeof fact.title === "string" ? fact.title : "";
			const content = typeof fact.content === "string" ? fact.content : "";
			if (title.trim() === "" && content.trim() === "") continue;
			facts.push({
				title,
				content,
				...(typeof fact.path === "string" && fact.path.trim() !== "" ? { path: fact.path } : {}),
			});
		}
	}
	return {
		summary: typeof record.summary === "string" ? record.summary : "Consolidated memory",
		rationale: typeof record.rationale === "string" ? record.rationale : "",
		facts,
	};
}

export interface PlanMemoryConsolidationOptions {
	headers?: Record<string, string>;
	signal?: AbortSignal;
	maxTokens?: number;
}

export async function planMemoryConsolidation(
	request: ConsolidationRequest,
	model: Model<any>,
	apiKey: string,
	options: PlanMemoryConsolidationOptions = {},
): Promise<ConsolidationProposal> {
	const existingBlock =
		request.existingMemories.length === 0
			? "(no harness memories yet)"
			: request.existingMemories.map((memory) => `- [${memory.id}] ${memory.title}: ${memory.content}`).join("\n");
	const userPrompt = [
		`<existing_memories>\n${existingBlock}\n</existing_memories>`,
		`<session>\n${request.conversationText}\n</session>`,
	].join("\n\n");

	const response = await completeSimple(
		model,
		{
			systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		},
		{
			maxTokens: options.maxTokens ?? consolidationMaxOutputTokens(model),
			signal: options.signal,
			apiKey,
			headers: options.headers,
		},
	);

	if (response.stopReason === "error") {
		throw new Error(`Memory consolidation failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "length") {
		throw new Error("Memory consolidation failed: the model stopped before completing its JSON object");
	}
	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return parseConsolidationResponse(text);
}
