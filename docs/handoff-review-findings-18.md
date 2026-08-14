# Handoff: six deferred v0.23 review findings (issue #18)

Branch `feat/review-findings-18` (isolated worktree
`.worktrees/review-findings-18`, cut from origin/main = 84694aa49). Never
touched the shared main tree.

## Outcome

All six findings were verified against current main. Five are superseded:
their code (from-scratch provider selection, wizard, ledger pricing stack,
box-menu raw mode) was never ported in the ADR-0015 restart. One left real
drift and was fixed as documentation: ADR-0010 still described the
from-scratch pricing stack, so it gained an "Adapted for the prime
baseline" section. No code changes were needed or made.

## Per-finding dispositions

1. **Spec #c1 (dummy-key shadow survives first boot)** — SUPERSEDED.
   `resolveInitialProvider` / `lastActive` / the first-usable-entry
   heuristic do not exist. Provider boot on this baseline is
   `--provider`/`--model` flags + `ModelRegistry.find` + session restore
   (main.ts ~836).
2. **Spec #c2 (wizard never writes the rates it fetches)** — SUPERSEDED.
   No provider wizard exists on this baseline.
3. **Spec #c3 (/effort dead on env-key boots)** — SUPERSEDED. `/effort`
   (`handleEffortCommand`, interactive-mode.ts 8025) reads thinking levels
   from `connectionState.availableThinkingLevels`, the live connection;
   the old `initial.name` refusal path does not exist.
4. **Spec #a3 (costUsd omitted vs 0; ADR gates only session.meta)** —
   DOCUMENTED / AMENDED. No `costUsd` run-result field and no
   `session.meta` channel exist here; the extension derives totals from
   persisted entries and `/cost` renders honest `$0.0000`. ADR-0010 gained
   the adaptation section so the ADR no longer describes the dropped
   `costOf`/`ratesFor`/catalog stack.
5. **Public ledger API creep** — SUPERSEDED. `src/index.ts` exports
   nothing ledger-related; `formatUsd` exists only extension-internal.
   Nothing to trim.
6. **Standards #5 (dead interactive raw-mode box-menu path)** — SUPERSEDED.
   `runBoxMenu` / `reduceMenuKey` / the `interactive` option do not exist;
   the current menus (menu-panel.ts, configuration-menu.ts, ADR-0036)
   carry no raw-mode path. Nothing to prune.

## What was verified

- Symbol-level audit against main: none of `resolveInitialProvider`,
  `runProviderWizard`, `CATALOG_RATES`, `costUsd`, `reduceMenuKey`,
  `runBoxMenu`, `costOf`, `ratesFor`, `DEFAULT_RATES`, `CostRates` appear
  in `packages/coding-agent/src` (only `formatUsd`, extension-internal).
- Provider boot path reviewed (main.ts); /effort implementation reviewed
  (interactive-mode.ts); ledger extension reviewed (ledger.ts, index.ts,
  storage.ts); src/index.ts export list reviewed.
- Ledger extension suite green; `tsgo --noEmit` clean; biome clean on the
  touched docs. Docs-only change, so no red tests apply.

## Files changed

- `docs/adr/ADR-0010-cost-ledger.md` — appended "Adapted for the prime
  baseline (ADR-0015, 2026-08-14)".
- `docs/handoff-review-findings-18.md` — this file.
