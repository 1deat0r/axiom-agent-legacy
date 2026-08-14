# Live verification — operator-gated harness for the deferred live passes

Date: 2026-08-15 · Branch: feat/live-verification · ADR: ADR-0058 · Issue: #36

## Problem

Six ADRs defer live passes to the operator ("the live pass is the operator
follow-up", ADR-0017/0020/0021; equivalent phrasings in ADR-0016, 0023, 0029,
0052). The passes had no script, no catalog, no CI trigger, and no checklist —
nothing to run when the operator finally had keys in hand.

## What changed

- `tools/live-verification/catalog.mjs` + `run.mjs`: four checks
  (provider-chat, agent-run, rlm-kernel, gateway-delivery) with the
  skip-not-fail exit contract — missing keys are SKIP with a reason, all-SKIP
  is exit 0, exit 1 means a check that ran failed.
- `.github/workflows/live-verification.yml`: on-demand dispatch plus a
  `/run-live` PR comment; secrets map 1:1 onto env names; the PR report
  comment posts only when something ran, so keyless runs are silent.
- `docs/live-verification.md`: the operator ledger — one checkbox per
  deferred ADR follow-up.

## Verified

28 new tests (18 harness logic + 10 workflow schema), red-first and offline;
biome and tsgo clean. Live execution is the operator's pass, not the sandbox's.
