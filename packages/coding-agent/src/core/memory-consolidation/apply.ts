/**
 * Apply accepted facts as harness memory entries. This is the write path for
 * both the auto-apply mode and the operator's `approve` command, so both go
 * through the same refinement machinery (validation, conflict detection,
 * versioning, refinement-event recording) and land in the same global
 * harness_state.json with `source: "consolidate"` provenance. Entries are
 * rollback-able like any other refinement via the global refinement history.
 */

import type { HarnessState, RefinementResult } from "../refinement/index.js";
import {
	appendGlobalRefinement,
	applyRefinementProposal,
	loadHarnessState,
	saveHarnessState,
} from "../refinement/index.js";
import { evaluateMemoryFacts } from "./gate.js";
import type { MemoryFact } from "./types.js";

export interface ApplyMemoryFactsOptions {
	facts: readonly MemoryFact[];
	harnessStateDir: string;
	proposalId?: string;
	sessionId?: string;
	summary?: string;
	rationale?: string;
	/** Injectable so tests can apply against a synthetic state without disk. */
	loadState?: (dir: string) => HarnessState;
}

export interface ApplyMemoryFactsResult {
	/** The refinement result, when at least one fact was applied. */
	result?: RefinementResult;
	/** Facts the gate dropped at apply time (bounds/dedup vs current state). */
	skipped: { fact: MemoryFact; reasons: string[] }[];
	/** Number of entries actually created in the harness. */
	acceptedCount: number;
}

export function applyMemoryFacts(options: ApplyMemoryFactsOptions): ApplyMemoryFactsResult {
	const state = (options.loadState ?? loadHarnessState)(options.harnessStateDir);
	const existing = Object.entries(state.entries.memory).map(([id, entry]) => ({
		id,
		title: entry.title,
		content: entry.content,
	}));
	// Re-gate against the CURRENT state: the proposal may have been staged
	// minutes ago, and the operator (or another session) may have added
	// memories since — apply-time dedup is the honest second line.
	const gate = evaluateMemoryFacts(options.facts, { existing });
	if (gate.accepted.length === 0) {
		return { skipped: gate.rejected, acceptedCount: 0 };
	}

	const id = `mc_apply_${new Date()
		.toISOString()
		.replace(/[^0-9]/g, "")
		.slice(0, 17)}`;
	const result = applyRefinementProposal(
		state,
		{
			summary: options.summary ?? `Consolidated ${gate.accepted.length} durable fact(s)`,
			rationale: options.rationale ?? "Extracted from a completed session by automatic memory consolidation.",
			expectedOutcome: "Future sessions recall these durable facts without re-learning them.",
			edits: gate.accepted.map((fact) => ({
				action: "create",
				kind: "memory",
				title: fact.title,
				content: fact.content,
				path: fact.path ?? "general",
				metadata: {
					source: "memory-consolidation",
					...(options.proposalId ? { proposalId: options.proposalId } : {}),
					...(options.sessionId ? { sessionId: options.sessionId } : {}),
				},
				reason: "Durable fact from a completed session",
			})),
		},
		{ id, scope: "global", source: "consolidate" },
	);
	saveHarnessState(options.harnessStateDir, state);
	appendGlobalRefinement(options.harnessStateDir, result);
	return {
		result,
		skipped: gate.rejected,
		acceptedCount: result.appliedEdits.filter((edit) => edit.applied).length,
	};
}
