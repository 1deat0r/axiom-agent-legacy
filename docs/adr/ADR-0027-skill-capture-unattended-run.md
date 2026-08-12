# ADR-0027: Unattended skill capture (runtime hook)

**Status:** accepted
**Date:** 2026-08-12
**Extends:** ADR-0024 (capture), ADR-0025 (audit), ADR-0026 (auto flagging)
**Implements:** step 4 (fully-unattended trigger) of the procedural-memory skills feature

## Context

ADR-0026 shipped the automatic flagging *decision* + a CLI to drive it, but
still required a caller to run the command. The feature's end state is that
Axiom turns hard-won task sequences into skills on its own, with no one asking.
This ADR closes that gap with the runtime hook: at the end of an agent run,
evaluate whether a completed task was reusable and, if so, capture + offer it.

## Decision

A **built-in Axiom extension** (`src/extensions/skill-capture/`) that hooks
`agent_end`:

- `buildTaskTraceFromMessages(messages)` — a pure, unit-tested builder that
  reads a session's message history into a `TaskTrace`: the first user prompt,
  the ordered tool-call summaries (the steps), and completion (last assistant
  `stopReason === "stop"`, so errors/aborts/length are not treated as done).
- On `agent_end`, when enabled and the task is flagged reusable, it materializes
  a skill through the ADR-0024 pipeline (`buildSkillDocument` →
  `persistCapturedSkill` no-overwrite → `verifyCapturedSkill` via the real
  loader) into `<AXIOM_HOME>/captured-skills` (or an injected dir) and surfaces
  an offer via `ctx.ui.notify`.
- **Inert by default**: it only acts when enabled (`AXIOM_SKILL_CAPTURE_AUTO=1`
  env or injected `enabled`), matching the workspace root-guard pattern
  (ADR-0018). It never blocks or disrupts a run — it only records + notifies.
- Registered as one of the axiom built-in extensions beside ledger, memory,
  profile, and workspace.

## Honest boundary (recorded, not faked)

- The heuristic (ADR-0026) is the reuse judgment, not a model guess — it is
  conservative and tunable, and this hook merely stages the offer.
- **Hub/sync over agentskills.io remains out of scope** — it needs external
  network/spec + credentials and is not testable in this sandbox.
- The captured skill is generated from the agent's own session (not an untrusted
  third party); the AST-level guard (ADR-0025) remains the screen applied
  before running skills obtained from elsewhere.

## Consequences

- A reusable completed task is captured and offered with no caller, closing the
  loop on the feature's end state.
- Ordinary sessions are unaffected (inert unless enabled); capture is
  non-blocking and no-overwrite.
- Reuses the existing capture/verify pipeline, so every unattended capture still
  carries provenance (`source: "auto"`) and must load cleanly via the real
  loader.
- Fully unit-tested (5 extension tests) alongside capture (25), audit (12), and
  evaluate (11) suites.
