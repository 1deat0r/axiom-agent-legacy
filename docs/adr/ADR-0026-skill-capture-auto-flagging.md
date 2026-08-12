# ADR-0026: Automatic flagging for skill capture

**Status:** accepted
**Date:** 2026-08-12
**Extends:** ADR-0024 (skill capture) + ADR-0025 (skill security audit)
**Implements:** step 3 (automatic flagging) of the procedural-memory skills feature

## Context

ADR-0024 captures a *flagged-reusable* task into a skill, but the flag was
explicit — a caller had to say "capture this." The feature's promise is that
Axiom turns hard-won task sequences into skills on its own. This ADR adds the
judgment: after a task completes, decide whether it is reusable enough to
capture, and only then materialize the skill through the existing pipeline.

## Decision

An **automatic flagging step** layered on the capture pipeline:

- **`evaluateTaskForCapture(trace)`** (`core/skill-capture/evaluate.ts`) — a
  deterministic, tunable heuristic over a task trace (prompt + steps +
  completion + metadata). It scores on: complexity/structure (step count, capped
  at 6), generic-reuse language signals (`reusable`, `pattern`, `every time`,
  `red-green`, ...), one-off signals (`one-time`, `throwaway`, `scratch`, ...),
  and completion. A task is flagged when complete and score >= 0.55. Weights,
  the signal lists, the minimum step count, and the threshold are explicit
  exported constants so operator feedback can tune sensitivity without refactor.
- **`axiom skill-capture-auto <trace.json> [--out] [--force] [--json]`** — CLI
  that reads a trace, runs the heuristic, and only when flagged (or with
  `--force`) builds/persists/verifies/offers the skill via the ADR-0024
  pipeline. Un-flagged tasks report the reasons and suggest `--force`.
- **Provenance** is set to `source: "auto"` so a captured skill records that it
  came from automatic flagging rather than a manual request.

## Honest boundary (recorded, not faked)

- The reuse judgment is **heuristic, not model-driven**. It is deliberately
  conservative and exposed for tuning; it does not replace the agent's own
  judgment, it stages the *offer*.
- **Fully unattended trigger** (a hook that runs `evaluateTaskForCapture` at the
  end of every session and auto-offers without a caller) is a documented
  follow-up; this ADR delivers the reusable decision function + the CLI the
  runtime hook would call. Hub/sync over agentskills.io also remains later.

## Consequences

- A completed, structurally-reusable task can be captured with no explicit flag,
  closing the loop on "the agent flags a task as reusable."
- Thin/one-off/incomplete tasks are not captured, avoiding skill noise; `--force`
  is the operator escape hatch.
- The heuristic reuses the existing capture + verify pipeline, so captured skills
  still carry provenance and must load cleanly via the real loader.
- Fully unit-tested (11 tests) alongside the capture (25) and audit (12) suites.
