# Feature log — Agent-side automatic memory consolidation (ADR-0037, issue #19)

**Branch:** `feat/memory-consolidation` (isolated worktree `.worktrees/memory-consolidation`)
**Base:** `main` @ 00da2f3f0
**Date:** 2026-08-13

## What shipped

Post-run consolidation that extracts durable facts from a completed session and
turns them into harness memory entries — recall is the read path, /refine is
manual, and this closes the loop automatically. Complements skill-capture's
auto-flagging: tasks → skills (procedural), facts → harness memory (declarative).

- `packages/coding-agent/src/core/memory-consolidation/` — pure core:
  `types.ts`, `request.ts` (session → request, 40k tail, existing-memory
  overview), `propose.ts` (model pass via `completeSimple`, shared
  `extractJsonObject` recovery), `gate.ts` (deterministic durability gate:
  bounds + transient signals + dedup), `store.ts` (pending proposals + audit
  JSONL), `apply.ts` (re-gate vs current state → harness memory creates with
  `source: "consolidate"` → save + global refinement history), `index.ts`.
- `packages/coding-agent/src/extensions/memory-consolidation/index.ts` —
  `agent_end` hook, inert unless `AXIOM_MEMORY_CONSOLIDATION=1`; propose mode
  stages + notifies; `AXIOM_MEMORY_CONSOLIDATION_AUTO=1` applies with audit;
  silent skip without auth; failures audited, never crash a run.
- `packages/coding-agent/src/cli/memory-consolidation-command.ts` —
  `axiom memory-consolidation pending|show|approve|reject|audit`, wired into
  `main.ts`.
- `packages/coding-agent/src/core/refinement/refinement.ts` — two minimal
  additions: `extractJsonObject` exported (shared JSON recovery) and an
  optional `source` option on `applyRefinementProposal` (default "refine").
- Docs: `docs/adr/ADR-0037-memory-consolidation.md`, `CONTEXT.md` term,
  this log, handoff.

## Verified, and how

- **Unit (red-first on refinement changes; mutation-checked core)** — 29 core
  + 7 extension + 13 CLI + 3 new refinement provenance/extract tests = 52 new
  tests, all green. A deliberate mutation that disabled existing-memory dedup
  failed 3 core tests (the guard is load-bearing).
- **Full `./test.sh`** — 4853 passed, 14 failed = ONLY the documented sandbox
  known-fails (daemon-serialized-refine ×1, 4603 ×4, 4685 ×9 EXDEV); identical
  set to the pristine baseline.
- **biome clean; tsgo --noEmit clean.**
- **Live CLI smoke (scratch `AXIOM_HOME`/`AXIOM_CODING_AGENT_DIR`, real dist
  bundle)** — staged a 2-fact proposal; `approve` applied the durable fact
  (`source: consolidate`, metadata proposalId/sessionId, refinement history
  written) and gated the transient "this session" fact with a visible reason;
  duplicate re-approve honestly skipped ("nothing new to apply"); `reject`
  discarded + audited; `audit` showed 3 newest-first events with reasons.

## Follow-ups (honest)

- Live cross-provider pass with real API keys (operator-gated).
- Consider auditing a `skipped` (all-gated-out) decision — currently a
  no-op is silent by design.
- Child sessions inherit the env flags and consolidate into the same global
  store (documented in the ADR; bounded by gate + dedup).
