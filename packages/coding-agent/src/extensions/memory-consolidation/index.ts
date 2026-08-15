/**
 * Memory-consolidation extension — the runtime hook that closes the loop on
 * "gets smarter over time": recall is the read path and /refine is manual, but
 * nothing auto-persisted durable facts learned across sessions. On
 * `session_shutdown` with reason `quit` — the session's real end in every mode
 * (one-shot process exit, daemon session close/passivation, interactive quit) —
 * this extension reviews the finished session, proposes durable facts, passes
 * them through the deterministic durability gate, and either:
 *
 *  - applies them immediately with a full audit trail (silent-by-default,
 *    per the autonomy direction ADR-0078), or
 *  - stages them for operator confirmation (opt-in confirm mode,
 *    AXIOM_MEMORY_CONSOLIDATION_AUTO=0; `axiom memory-consolidation pending`
 *    to review).
 *
 * Enabled and silent by default (AXIOM_MEMORY_CONSOLIDATION=0 to disable),
 * per the autonomy direction ADR-0078 — the loop writes what it owns without
 * asking, every write lands in the append-only audit log, and rollback stays
 * available through the refinement history. It never blocks or crashes a
 * run: without model auth it skips silently; any failure is audited and
 * swallowed.
 *
 * The hook is session_shutdown, NOT agent_end: in resident sessions
 * (interactive TUI, daemon workers) agent_end fires after every prompt, and
 * consolidating per prompt would add a model call to every turn — against the
 * ADR-0078 "cheap per turn" posture. Only `quit` consolidates: it is emitted
 * by every mode's dispose path (one-shot process exit and daemon session
 * close both await their shutdown handlers), while new/resume/fork are
 * session switches and reload is not an end.
 *
 * The write paths are lattice-routed (ADR-0081): before applying or staging,
 * the hook admits the target through the ownership lattice with the learning
 * actor's toolset (memory.apply / memory.stage). In the live layout those
 * paths are curator territory, so the checks admit unchanged; a refusal is
 * audited through the witness append (the sanctioned primitive, which is not
 * itself lattice-routed) and nothing is written.
 */

import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir, getBundledSkillsDir } from "../../config.js";
import type { ExtensionAPI } from "../../core/extensions/types.js";
import {
	type ApplyMemoryFactsResult,
	appendAuditEvent,
	applyMemoryFacts,
	buildConsolidationRequest,
	type ConsolidationAuditEvent,
	type ConsolidationProposal,
	type ConsolidationRequest,
	consolidationAuditPath,
	consolidationPendingDir,
	evaluateMemoryFacts,
	type GateResult,
	type MemoryFact,
	type MemoryOverviewEntry,
	newProposalId,
	type PendingProposal,
	planMemoryConsolidation,
	stagePendingProposal,
} from "../../core/memory-consolidation/index.js";
import {
	admitWrite,
	CONSOLIDATION_DIR_NAME,
	defaultLatticeConfig,
	type LatticeConfig,
} from "../../core/ownership-lattice/index.js";
import { getGlobalHarnessStateDir, type HarnessState, loadHarnessState } from "../../core/refinement/index.js";
import type { SessionMessageEntry } from "../../core/session-manager.js";
import { axiomHome } from "../profile/registry.js";

export interface MemoryConsolidationExtensionOptions {
	/** Enable post-run consolidation (default AXIOM_MEMORY_CONSOLIDATION=1). */
	enabled?: boolean;
	/** Apply accepted facts immediately instead of staging (default AXIOM_MEMORY_CONSOLIDATION_AUTO=1). */
	auto?: boolean;
	/** Consolidation root (pending + audit); default <AXIOM_HOME>/consolidation. */
	consolidationDir?: string;
	/** Global harness state dir (default getGlobalHarnessStateDir()). */
	harnessStateDir?: string;
	/** Lattice view for write admission (default: the live profile/agent/cwd dirs). */
	latticeConfig?: LatticeConfig;
	/** Injectable pieces so tests isolate one concern without disk/model IO. */
	buildRequest?: (
		messages: readonly AgentMessage[],
		options: { sessionId?: string; existingMemories: readonly MemoryOverviewEntry[] },
	) => ConsolidationRequest;
	plan?: (
		request: ConsolidationRequest,
		model: Model<any>,
		apiKey: string,
		options: { headers?: Record<string, string>; signal?: AbortSignal },
	) => Promise<ConsolidationProposal>;
	gate?: (facts: readonly MemoryFact[], options: { existing?: readonly MemoryOverviewEntry[] }) => GateResult;
	stage?: (pendingDir: string, proposal: ConsolidationProposal, options: { sessionId?: string }) => PendingProposal;
	apply?: (options: {
		facts: readonly MemoryFact[];
		harnessStateDir: string;
		proposalId?: string;
		sessionId?: string;
		summary?: string;
		rationale?: string;
	}) => ApplyMemoryFactsResult;
	audit?: (auditPath: string, event: ConsolidationAuditEvent) => string;
	loadExistingMemories?: (harnessStateDir: string) => MemoryOverviewEntry[];
}

function defaultBuildRequest(
	messages: readonly AgentMessage[],
	options: { sessionId?: string; existingMemories: readonly MemoryOverviewEntry[] },
): ConsolidationRequest {
	return buildConsolidationRequest(messages, options);
}

function defaultLoadExistingMemories(harnessStateDir: string): MemoryOverviewEntry[] {
	return memoryOverview(loadHarnessState(harnessStateDir));
}

/** Read-only summary of current global harness memories for dedup + requests. */
export function memoryOverview(state: HarnessState): MemoryOverviewEntry[] {
	return Object.entries(state.entries.memory).map(([id, entry]) => ({
		id,
		title: entry.title,
		content: entry.content,
	}));
}

function rejectedReasons(gate: GateResult, applied?: ApplyMemoryFactsResult): string[] {
	const reasons = gate.rejected.map(
		(rejection) => `${rejection.fact.title || "(untitled)"}: ${rejection.reasons.join("; ")}`,
	);
	if (applied) {
		for (const skip of applied.skipped) {
			reasons.push(`${skip.fact.title || "(untitled)"}: ${skip.reasons.join("; ")}`);
		}
	}
	return reasons;
}

export function createMemoryConsolidationExtension(
	deps: MemoryConsolidationExtensionOptions = {},
): (pi: ExtensionAPI) => void {
	// Silent by default (ADR-0078): consolidation is on and auto-applies.
	// Opt out explicitly with AXIOM_MEMORY_CONSOLIDATION=0 (off) or
	// AXIOM_MEMORY_CONSOLIDATION_AUTO=0 (stage-for-confirmation).
	const enabled = deps.enabled ?? process.env.AXIOM_MEMORY_CONSOLIDATION !== "0";
	const auto = deps.auto ?? process.env.AXIOM_MEMORY_CONSOLIDATION_AUTO !== "0";
	const consolidationDir = deps.consolidationDir ?? join(axiomHome(), CONSOLIDATION_DIR_NAME);
	const pendingDir = consolidationPendingDir(consolidationDir);
	const auditPath = consolidationAuditPath(consolidationDir);
	const harnessStateDir = deps.harnessStateDir ?? getGlobalHarnessStateDir();
	const buildRequest = deps.buildRequest ?? defaultBuildRequest;
	const plan = deps.plan ?? planMemoryConsolidation;
	const gate = deps.gate ?? evaluateMemoryFacts;
	const stage = deps.stage ?? stagePendingProposal;
	const apply = deps.apply ?? applyMemoryFacts;
	const audit = deps.audit ?? appendAuditEvent;
	const loadExistingMemories = deps.loadExistingMemories ?? defaultLoadExistingMemories;

	return (pi) => {
		pi.on("session_shutdown", async (event, ctx) => {
			if (!enabled) return;
			// Only a real session end consolidates: quit is emitted by every
			// mode's dispose path. new/resume/fork are session switches (the
			// old session lives on in the tree) and reload is not an end.
			if (event.reason !== "quit") return;
			try {
				const model = ctx.model;
				if (!model) return;
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok || !auth.apiKey) return;

				const sessionId = ctx.sessionManager.getSessionId() || undefined;
				const messages = ctx.sessionManager
					.getEntries()
					.filter((entry): entry is SessionMessageEntry => entry.type === "message")
					.map((entry) => entry.message);
				const request = buildRequest(messages, {
					...(sessionId ? { sessionId } : {}),
					existingMemories: loadExistingMemories(harnessStateDir),
				});
				const proposal = await plan(request, model, auth.apiKey, { headers: auth.headers, signal: ctx.signal });
				const gateResult = gate(proposal.facts, { existing: request.existingMemories });
				if (gateResult.accepted.length === 0) return;

				// The lattice view is built only when a write is imminent: the
				// live layout admits harness memory and pending staging
				// unchanged (curator territory); anything else is refused and
				// audited through the witness append.
				const lattice =
					deps.latticeConfig ??
					defaultLatticeConfig({
						axiomHome: axiomHome(),
						agentDir: getAgentDir(),
						cwd: ctx.cwd,
						bundledSkillsDir: getBundledSkillsDir(),
						harnessStateDir,
					});

				if (auto) {
					// The harness memory write is lattice-routed (ADR-0081): the
					// learning actor applies only where the lattice admits it —
					// in the live layout that is curator territory, so the check
					// admits unchanged. A refusal is audited through the witness
					// append (the sanctioned primitive, not lattice-routed).
					const admission = admitWrite(harnessStateDir, { actor: "learning", operation: "memory.apply" }, lattice);
					if (!admission.admitted) {
						audit(auditPath, {
							id: `mc_audit_${Date.now()}`,
							action: "failed",
							proposed: proposal.facts.length,
							accepted: 0,
							rejected: [],
							error: `lattice refused memory.apply: ${admission.reason}`,
							createdAt: new Date().toISOString(),
						});
						return;
					}
					const proposalId = newProposalId();
					const applied = apply({
						facts: gateResult.accepted,
						harnessStateDir,
						proposalId,
						...(sessionId ? { sessionId } : {}),
						summary: proposal.summary,
						rationale: proposal.rationale,
					});
					const entryIds =
						applied.result?.appliedEdits.filter((edit) => edit.applied).map((edit) => edit.id) ?? [];
					audit(auditPath, {
						id: `mc_audit_${Date.now()}`,
						action: "auto_applied",
						proposalId,
						...(sessionId ? { sessionId } : {}),
						proposed: proposal.facts.length,
						accepted: applied.acceptedCount,
						rejected: rejectedReasons(gateResult, applied),
						...(entryIds.length > 0 ? { entryIds } : {}),
						createdAt: new Date().toISOString(),
					});
					ctx.ui.notify(
						applied.acceptedCount > 0
							? `Memory consolidation applied ${applied.acceptedCount} durable fact(s) to the harness (audited)`
							: "Memory consolidation: no new durable facts survived the gate",
						"info",
					);
					return;
				}

				// Propose mode: only gate-accepted facts are staged for review.
				// Pending staging is lattice-routed too (memory.stage on curator
				// territory); a refusal is audited and nothing is staged.
				const admission = admitWrite(pendingDir, { actor: "learning", operation: "memory.stage" }, lattice);
				if (!admission.admitted) {
					audit(auditPath, {
						id: `mc_audit_${Date.now()}`,
						action: "failed",
						proposed: proposal.facts.length,
						accepted: 0,
						rejected: [],
						error: `lattice refused memory.stage: ${admission.reason}`,
						createdAt: new Date().toISOString(),
					});
					return;
				}
				const staged = stage(
					pendingDir,
					{ summary: proposal.summary, rationale: proposal.rationale, facts: gateResult.accepted },
					{ ...(sessionId ? { sessionId } : {}) },
				);
				audit(auditPath, {
					id: `mc_audit_${Date.now()}`,
					action: "staged",
					proposalId: staged.id,
					...(sessionId ? { sessionId } : {}),
					proposed: proposal.facts.length,
					accepted: staged.facts.length,
					rejected: rejectedReasons(gateResult),
					createdAt: new Date().toISOString(),
				});
				ctx.ui.notify(
					`Memory consolidation staged ${staged.facts.length} durable fact(s) — review with \`axiom memory-consolidation pending\``,
					"info",
				);
			} catch (error) {
				// The hook must never crash a run: failures are audited and swallowed.
				try {
					audit(auditPath, {
						id: `mc_audit_${Date.now()}`,
						action: "failed",
						proposed: 0,
						accepted: 0,
						rejected: [],
						error: error instanceof Error ? error.message : String(error),
						createdAt: new Date().toISOString(),
					});
				} catch {
					// Even the audit can fail (disk issues) — still never throw.
				}
			}
		});
	};
}

export default function axiomMemoryConsolidationExtension(pi: ExtensionAPI): void {
	createMemoryConsolidationExtension()(pi);
}
