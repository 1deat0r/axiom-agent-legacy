/**
 * Types for automatic memory consolidation: post-run extraction of durable
 * facts from a completed session into proposed harness memory entries.
 *
 * The feature mirrors skill-capture's shape (ADR-0024/0026/0027): a
 * deterministic core (gate + store + apply) plus an inert-by-default runtime
 * hook. `MemoryFact` is the proposal unit; `ConsolidationProposal` is what a
 * model (or any caller) produces; `PendingProposal` is the staged, operator-
 * confirmable form; `ConsolidationAuditEvent` is the audit trail for every
 * decision the feature takes.
 */

/** A single durable fact proposed for harness memory. */
export interface MemoryFact {
	/** Short label for the fact (used as the harness entry title). */
	title: string;
	/** The durable fact body. Compact and specific, not task progress. */
	content: string;
	/** Optional grouping path (default "general"). */
	path?: string;
}

/** The model-produced consolidation proposal. */
export interface ConsolidationProposal {
	summary: string;
	rationale: string;
	facts: MemoryFact[];
}

/** What the model is shown when proposing facts. */
export interface ConsolidationRequest {
	/** Serialized session text (bounded tail). */
	conversationText: string;
	/** Existing global harness memories, for deduplication. */
	existingMemories: readonly MemoryOverviewEntry[];
	/** Session the facts came from (provenance only). */
	sessionId?: string;
}

export interface MemoryOverviewEntry {
	id: string;
	title: string;
	content: string;
}

/** A proposal staged for operator confirmation. */
export interface PendingProposal extends ConsolidationProposal {
	id: string;
	sessionId?: string;
	createdAt: string;
}

export type ConsolidationAuditAction = "staged" | "approved" | "rejected" | "auto_applied" | "failed";

/** One line in the consolidation audit log. */
export interface ConsolidationAuditEvent {
	id: string;
	action: ConsolidationAuditAction;
	proposalId?: string;
	sessionId?: string;
	/** How many facts the model proposed. */
	proposed: number;
	/** How many facts the gate accepted (or were applied). */
	accepted: number;
	/** Per-fact rejection reasons (gate + apply-time dedup). */
	rejected: string[];
	/** Harness entry ids that were created (approved / auto_applied). */
	entryIds?: string[];
	/** Error message for failed actions. */
	error?: string;
	createdAt: string;
}

/** Deterministic gate output: which facts survive, and why others did not. */
export interface GateResult {
	accepted: MemoryFact[];
	rejected: { fact: MemoryFact; reasons: string[] }[];
}
