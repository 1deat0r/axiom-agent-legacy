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

## Adapted for the Hermes baseline (ADR-0087, 2026-08-16)

The ADR-0087 re-foundation moved Axiom onto the Hermes Agent baseline
(port #5, issue #65). The adaptation supersedes parts of the decision text
above; the semantics (hard pre-call guard, `0` disables calls, absent = no
cap, recorded usage only) are unchanged from ADR-0010/0011.

- **There is no prime-era `parseArgs`/`tuiOptionsFrom`/`sessionLedger`
  surface here.** The flag and the guard land where Hermes actually lives:
  - **The guard** is a tiny pure function (`agent/spend_cap.py::
    spend_cap_exceeded`) called at the top of the tool loop
    (`agent/conversation_loop.py`, before `api_call_count` is incremented).
    When recorded spend reaches the cap it sets `_turn_exit_reason =
    "cost_limit"`, composes a user-facing `final_response`, and `break`s —
    no further LLM call. `finalize_turn` excludes `cost_limit` from
    `completed` so a capped run is not recorded as a completed turn.
  - **The flag** is `--max-run-cost <usd>` on the top-level parser
    (`hermes_cli/_parser.py`, `_inherited_flag` so relaunch carries it),
    forwarded through `cmd_chat` into `cli.main(max_run_cost=...)` →
    `HermesCLI` → `AIAgent(max_run_cost_usd=...)`; and through
    `_launch_tui(max_run_cost=...)` → `HERMES_TUI_MAX_RUN_COST` → the TUI
    gateway's `AIAgent(max_run_cost_usd=_cfg_max_run_cost())`.
- **`maxRunCostUsd` becomes `AIAgent(max_run_cost_usd=...)`** (`Optional[float]`,
  `None` = no cap), threaded through the `AIAgent.__init__` →
  `agent.agent_init.init_agent` chain. The accumulator it guards is Hermes's
  existing `session_estimated_cost_usd` (ADR-0010 ledger).
- **Delegated subagents inherit the parent's cap value.** `delegate_tool`
  passes `max_run_cost_usd=getattr(parent_agent, "max_run_cost_usd", None)`
  into each child, mirroring ADR-0061 §4's "per-run, inherited" semantics:
  each child enforces its own cap against its own recorded spend, and the
  parent fold of child cost is the reconciliation point — not a shared
  budget (a persistent multi-run budget is deliberately out of scope per
  ADR-0061).
- **Verification**: red-first `tests/run_agent/test_max_run_cost.py`
  (pure-guard cases: no cap / `0` disables / below / at-or-above /
  no-usage provider / missing attribute; plus a `finalize_turn` case
  asserting a `cost_limit` stop makes no summary LLM call).

