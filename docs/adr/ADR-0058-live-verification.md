# ADR-0058: Operator-gated live verification harness

**Status:** accepted
**Date:** 2026-08-15
**Extends:** ADR-0016, ADR-0017, ADR-0020, ADR-0021 (gateway live passes), ADR-0023 (cross-transport verification), ADR-0029 (cross-provider validation)

## Context

The ADR series records a recurring honest boundary: the gateways (ADR-0016
Signal, ADR-0017 Telegram, ADR-0020 Discord, ADR-0021 Slack) are exercised by
their test suites and "the live pass is the operator follow-up"; cross-transport
fan-out (ADR-0023) and cross-provider validation (ADR-0029) are operator-gated
for the same reason — tokens and keys are operator-owned. Issue #36 is the
collecting point for those deferred passes.

The problem is not that the passes exist; it is that they have no home. Each
operator follow-up is a sentence in an ADR with no script, no catalog, no CI
trigger, and no checklist. When the operator finally has keys in hand, there is
nothing to run and no place to record the result.

## Decision

Ship an operator-gated harness, not the live pass itself. Three parts:

1. **`tools/live-verification/run.mjs`** — a zero-dependency Node script that
   catalogs four live checks and runs the subset whose prerequisites are
   present:

   - `provider-chat` — one real chat completion against a configured provider
     (deepseek, openai, anthropic, or gemini). Proves the key and the network
     path are live.
   - `agent-run` — one end-to-end agent run through the real CLI
     (`dist/cli.js --mode json`). Proves provider, model registry, session,
     and completion pipeline in one run.
   - `rlm-kernel` — boots the IPython kernel with the repo's own
     `KernelManager` and executes `print(1+1)`. Proves the kernel the RLM
     prompt relies on.
   - `gateway-delivery` — probes each configured transport token against its
     live API surface (Telegram `getMe`, Discord `users/@me`, Slack
     `auth.test`). Proves the token is live and the surface reachable.

   Each check carries a name, a purpose, its env requirements, and its
   expected output. `--list` prints the catalog; `--json` emits a
   machine-readable report for CI.

2. **Skip-not-fail exit contract.** A check whose requirements are absent is
   SKIPped with the reason, and all-SKIP is exit 0. Exit 1 means exactly "a
   check that ran failed". Missing keys can never fail a run — that is the
   property the unit tests encode (red-first, offline, no network).

3. **`.github/workflows/live-verification.yml`** — runs the harness on
   `workflow_dispatch` and on a PR comment `/run-live`. Repository secrets
   map one-to-one onto the exact env names the script reads. The PR report
   comment posts only when at least one check ran; an all-SKIP run stays
   silent. No secrets management here: keys are operator-owned, and the
   operator sets them in the repository secrets UI.

The operator checklist lives in `docs/live-verification.md`: every ADR
follow-up that defers a live pass to the operator, one checkbox per item,
linked back to the ADR that deferred it.

## Consequences

- The deferred live passes now have a scripted home and a CI trigger. Running
  them is `node tools/live-verification/run.mjs` (locally, with keys in the
  env) or a `/run-live` comment on a PR (with repository secrets set).
- The harness is the deliverable, not the pass: no live run happened in the
  sandbox, and the runners themselves are verified only by their offline
  skip/probe contract plus the repo's own live-gated suites they reuse.
- The catalog can grow without changing the contract: add a check to
  `catalog.mjs` with its requirements, and the skip/plan/summarize logic and
  the CI report pick it up.
- Scope boundaries, recorded: this ADR does not manage CI secrets, does not
  boot the gateway, and does not verify a full message round-trip. The
  round-trip remains the operator's manual pass (checkbox in
  `docs/live-verification.md`), and the gateway-delivery check proves the
  token surface only.

## Alternatives considered

- **Fold the live passes into the default CI test matrix.** Rejected: CI
  runners never hold operator keys; a keyless job would be permanently red or
  permanently skipped-with-noise, both worse than an explicit operator gate.
- **One script per provider/transport.** Rejected: the skip-not-fail contract
  is the hard part and belongs in one place; per-check scripts would each
  re-implement it and drift.
- **Boot the gateway inside the harness.** Rejected: interactive, token-heavy,
  and single-threaded; a CI-safe token probe plus an operator manual pass
  covers the same ground honestly.
