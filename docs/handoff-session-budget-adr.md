# Handoff — ADR-0041 for the session-budget feature (docs-only)

Branch: `issue-22` (isolated worktree `/tmp/axiom-worktrees/issue-22`).
Base: `main` @ `f23ebcf9a`.
Issue: #22 (one-capability-one-ADR gap: the session budget shipped without
an ADR).

## What was done

The session-budget capability (`GATEWAY_SESSION_BUDGET_BYTES`, in-place
archives, `/new`) shipped in commit c1d2ef9a6 with no ADR, breaking the
one-capability-one-ADR rule. This run closes the gap with documentation only
— no code changes:

1. `docs/adr/ADR-0041-gateway-session-budget.md` (new):
   Status/Context/Decision/Consequences, following the ADR-0039 shape.
   Context records the real incident (a channel session at ~508k real
   tokens / 2.6MB / 647 entries / zero compactions making every reply take
   about a minute, because deepseek-v4-pro's 1M-token window means
   auto-compaction can never fire). Decision records the 256KB soft cap, the
   in-place archive rename (`<id>.jsonl.archived-<ts>`), the reset notice
   riding the reply, the on-demand `/new` path, and the best-effort rule
   that checks never block a reply. Consequences record bounded continuity,
   archive accumulation without garbage collection (follow-up), and that
   auto-compaction is untouched.
2. `CONTEXT.md`: new vocabulary term "Session budget" placed after
   "Session", with an `_Avoid_` anti-drift line (context window /
   auto-compaction — the budget is a file-size gate, not a token limit).
3. `docs/feature-logs/session-budget.md` (new): problem / what changed /
   verified log of the feature, including the search-indexer follow-up
   (commit 41966e660) that made archives stay visible in `/search`.
4. This handoff.

## What was verified (unit / mock / live — honest labels)

- Unit: none run — docs-only change; no test files touched, so there is no
  new behavior to cover. The ADR's factual claims were checked against the
  shipped source on main: `src/gateway/session-reset.ts`, the budget check
  and notice wiring in `src/gateway/gateway.ts`,
  `src/gateway/commands/new.ts`, the two budget tests in
  `test/gateway/gateway.test.ts`, and commit 41966e660 (archived-name
  indexing). No drift found between the ADR and the code.
- Mock: n/a (nothing to mock in a docs change).
- Live: none this run — nothing was deployed. The feature itself was
  live-verified by the session that shipped it: the gateway unit was
  restarted with the new source and the over-budget 2.6MB session archived
  on the next message.
- Floor: `npx biome check .` clean; `npx tsgo --noEmit` clean (run from
  `packages/coding-agent`).

## Notes

- Archive garbage collection remains a recorded follow-up (ADR-0041
  Consequences); `/new` and the budget check are both on main.
- ADR numbering: 0041 continues the series after ADR-0040
  (memory-consolidation, renumbered at f23ebcf9a after its 0037 collision
  with skill-check).
