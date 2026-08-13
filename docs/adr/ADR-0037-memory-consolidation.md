# ADR-0037: Agent-side automatic memory consolidation

**Status:** accepted
**Date:** 2026-08-13
**Extends:** ADR-0024 (capture), ADR-0026 (auto flagging), ADR-0027 (unattended hook) — complements, not replaces
**Implements:** issue #19

## Context

Recall is the read path; harness refinement is manual. Nothing auto-persists
durable facts learned across sessions — the agent re-learns stable preferences,
environment quirks, and lessons every time. This is the single biggest
"gets smarter over time" unlock, and it is fully sandbox-testable because the
write path (harness memory entries) is local state, not a network service.

Skill-capture (ADR-0024–0027) solved the procedural half (tasks → skills).
This ADR solves the declarative half: durable facts → harness memory.

## Decision

Post-run consolidation that extracts durable facts from a completed session and
turns them into harness memory entries, gated by operator confirmation by
default, or applied automatically with a full audit trail.

**Core** (`src/core/memory-consolidation/`), deterministic and pure:

- `request.ts` — build a `ConsolidationRequest` from the session (bounded
  serialization via the same `serializeConversation`/`convertToLlm` path the
  refine planner uses, 40k tail) plus an existing-memory overview.
- `propose.ts` — the model pass (`completeSimple`), mirroring
  `planRefinement`'s call shape: a JSON reply `{summary, rationale,
  facts[{title, content, path}]}`, parsed with the shared `extractJsonObject`
  recovery (now exported from the refinement module).
- `gate.ts` — the deterministic durability gate (sibling of ADR-0026's
  flagging heuristic): title/content length bounds, word-boundary transient
  signals ("this session", "currently", "todo", "next step", …), and
  deduplication against existing global harness memory and within the proposal.
  Every rejection carries a human-readable reason so the audit explains itself.
- `store.ts` — pending proposals (`<AXIOM_HOME>/consolidation/pending/*.json`,
  stable `mc_<digits>` ids, no-overwrite) and the audit log
  (`<AXIOM_HOME>/consolidation/audit.jsonl`). Both tolerate malformed files.
- `apply.ts` — the single write path: re-gates against the **current** harness
  state (the state may have changed since staging), then applies accepted
  facts as memory creates through `applyRefinementProposal` with a new
  `source` option — provenance is `source: "consolidate"` and metadata carries
  `proposalId`/`sessionId`. The result is saved to `harness_state.json` and
  appended to the global refinement history, so consolidation entries are
  rollback-able like any refinement.

**Extension** (`src/extensions/memory-consolidation/`) — `agent_end` hook,
inert unless `AXIOM_MEMORY_CONSOLIDATION=1` (workspace root-guard pattern,
ADR-0018/0027):

- Propose mode (default): stage gate-accepted facts + notify the operator
  (`axiom memory-consolidation pending` to review).
- Auto mode (`AXIOM_MEMORY_CONSOLIDATION_AUTO=1`): apply immediately + audit.
- Skips silently when no model/auth is available; failures are audited as
  `failed` events and never crash or block a run.

**CLI** (`axiom memory-consolidation pending|show|approve|reject|audit`) —
the operator-confirm gate. `approve` re-gates and applies; `reject` discards;
both resolve the pending file and audit the decision.

## Honest boundary (recorded, not faked)

- The **proposal is model judgment, the gate is deterministic** — auto mode
  only ever applies facts that pass the gate, and every decision lands in the
  audit log first.
- Consolidation targets the **global** harness store (durable cross-session
  facts). Child-agent sessions inherit the env flags and would consolidate
  into the same store; the gate + dedup bound this, but operators running
  deeply recursive trees with auto mode on should expect that.
- **No live cross-provider pass yet** — the model call is unit-tested with a
  mocked provider; a real run needs operator API keys (recorded follow-up, same
  as skill-capture's).
- Consolidation only proposes **memory** entries. Procedural knowledge stays
  skill-capture's job; behavioral policy stays /refine's.

## Consequences

- Durable facts survive sessions without a manual `/refine` — the loop from
  "learned it again" to "already knows" closes.
- Ordinary sessions are unaffected (inert unless enabled); the hook is
  non-blocking and the write path is dedup-guarded twice (gate + apply).
- Every consolidation decision is auditable: staged/approved/rejected/
  auto_applied/failed events with reasons and entry ids.
- Reuses the refinement apply machinery, so consolidated entries obey the same
  validation, versioning, and rollback semantics as human refinements.
- Fully unit-tested (29 core + 7 extension + 13 CLI + refinement provenance
  tests) and CLI-smoke-tested end to end against a scratch home.
