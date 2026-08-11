# Spend cap on surfaces: one --max-run-cost flag for CLI and TUI

ADR-0011 records the decision for the v0.23 review pass: ADR-0010's spend
cap existed only at `AgentConfig` — no surface could set it. This ADR
documents how the surfaces expose it, and the shared session ledger they
now price from.

## Decisions

- **`--max-run-cost <usd>` is a launch-time flag on both surfaces**, parsed
  once in the CLI arg parser (`parseArgs`) and forwarded to the TUI entry
  through the same seam as every other flag (`tuiOptionsFrom`). Semantics
  are unchanged from ADR-0010: a hard pre-call guard ending
  `finishReason: 'cost_limit'`, `0` disables LLM calls, absent means no cap.
- **The cap is a launch property, like `--model` and `--provider` — not a
  per-session knob.** No `/cap` command, no persistence. A session-level
  cap would need per-session state and a storage shape ADR-0010
  deliberately avoids; a user who wants a cap on everything sets it once
  in their launch command (or aliases it).
- **`sessionLedger(sessions, id)` is the one implementation of
  session/lifetime spend**, living in `src/surface/commands.ts` beside
  `formatCost` (ADR-0005's shared-vocabulary home). The CLI's `/cost` and
  the TUI's cost pane used to each reimplement the same reduce over
  `session.meta.costUsd`; drift between surfaces is now impossible by
  construction.
- **Both surfaces set the cap the same way**: a conditional spread into
  `AgentConfig` (`maxRunCostUsd` when defined), identical to how
  `costRates` and `reasoningEffort` already ride in.

## Alternatives considered (and rejected)

- **`/cap <usd>` command.** Needs persistence, per-session semantics, and
  a `routeCommand` extension; the launch flag already covers the money
  thesis (a capped agent is capped from the moment it boots). A command
  can be added later without changing the core.
- **`AXIOM_MAX_RUN_COST` env var.** Kept as future work; the flag matches
  the existing `--model`/`--base-url`/`--api-key` launch vocabulary and
  needs no shell setup.
