# Handoff — Agent-side automatic memory consolidation (ADR-0040, issue #19)

**Branch:** `feat/memory-consolidation` (isolated worktree at `.worktrees/memory-consolidation`)
**Base:** `main` @ 00da2f3f0 (includes the parallel session's board loop-closure handoff)

## What was done

Post-run consolidation that extracts durable facts and proposes harness memory
entries, gated by operator confirm by default or auto-applied with a full
audit trail. Recall stays the read path; /refine stays manual; this closes the
"gets smarter over time" loop automatically and complements skill-capture.

- Core `packages/coding-agent/src/core/memory-consolidation/` (request →
  propose → gate → store → apply pipeline; see ADR-0040 for the design).
- Extension `src/extensions/memory-consolidation/` — `agent_end` hook, inert
  unless `AXIOM_MEMORY_CONSOLIDATION=1`; propose mode stages + notifies;
  `AXIOM_MEMORY_CONSOLIDATION_AUTO=1` auto-applies with audit; silent skip
  without auth; failures audited and never thrown.
- CLI `axiom memory-consolidation pending|show|approve|reject|audit` (wired
  into `main.ts`).
- Two minimal `refinement.ts` changes: `extractJsonObject` export + optional
  `source` on `applyRefinementProposal` (default "refine") — entries created
  by consolidation carry `source: "consolidate"` and are rollback-able via
  the existing refinement history.
- Docs: ADR-0040, CONTEXT.md term, feature-log, this handoff. Issue #19.

## What was verified, and how

- **Unit — 52 new tests green** (29 core, 7 extension, 13 CLI, 3 refinement
  provenance/extract additions). Red-first on the refinement changes; a
  mutation check confirmed the dedup tests catch real regressions.
- **Full `./test.sh`** — 4852 passed; failures are only documented
  sandbox/known-flake suites: daemon-serialized-refine ×1, 4603 ×4, 4685 ×9
  EXDEV hard-links, plus daemon-supervisor-process ×1 and
  kernel-agent-message-skill ×1 (both real-process/kernel flakes that pass
  standalone: 8 passed/8 skipped and 7/7). No regressions vs the pristine
  baseline.
- **biome clean; tsgo --noEmit clean.**
- **Live end-to-end CLI smoke** against a scratch `AXIOM_HOME` +
  `AXIOM_CODING_AGENT_DIR` with the real dist bundle: stage → show → approve
  (durable fact applied with consolidate provenance + rollback history;
  transient "this session" fact gated with a visible reason) → duplicate
  re-approve honestly skipped → reject → audit (3 newest-first events with
  rejection reasons).

## Honest boundaries

- No live cross-provider pass yet (model call unit-tested with a mocked
  provider; needs operator API keys) — recorded follow-up.
- A no-op consolidation (everything gated out) is deliberately silent (no
  audit line) — documented in the ADR and feature-log.
- Child sessions inherit the env flags and consolidate into the same global
  store — bounded by gate + dedup, documented.

## Post-first-commit polish (b07459587)

- Dropped the unused `ResolveAction` param from `resolvePendingProposal`
  (the caller's audit line carries the action).
- `approve` now reports applied entries honestly even when the pending file
  vanished mid-run.
- Added a `--json` audit output test.

## Merge/cleanup notes

- Branch NOT merged to main and NOT deleted yet (user hasn't asked).
- Worktree `.worktrees/memory-consolidation` shares `node_modules` via symlink
  from the main working tree (same as prior worktrees).
- Rebuilt the WORKTREE's dist bundle only; the main tree, `~/.local/bin/axiom`,
  and the live gateway are untouched.
