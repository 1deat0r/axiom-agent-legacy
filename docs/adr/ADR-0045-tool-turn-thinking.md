# ADR-0045 — Reduced reasoning on tool-followup turns (toolTurnThinkingLevel)

## Status
Accepted (2026-08-13)

## Context
Every agent turn pays the model's reasoning cost, including mechanical
tool-followup turns. Live deepseek-v4-pro sessions emit 200-760 reasoning
tokens per tool-loop turn even when the turn only continues an established
tooling plan; the final answer is usually short by comparison. The session
thinking level is fixed for the whole run (`AgentLoopConfig.reasoning`), so
there was no lever to trade per-turn reasoning depth for latency.

## Decision
Add an opt-in per-turn reasoning override:

- `AgentLoopConfig.getReasoningForTurn(context)` — when set, its return
  value replaces `reasoning` for the upcoming turn only
  (`packages/agent/src/agent-loop.ts` computes it per
  `streamAssistantResponse` call and passes it through the stream options).
- `Agent.toolTurnThinkingLevel` — when set, the loop config hook lowers
  reasoning to this level on turns whose previous assistant message
  contained tool calls (first turns and post-answer turns keep the
  session's full level). The value is clamped to the model's supported
  levels at construction.
- Settings key `toolTurnThinkingLevel` (default unset = off) + getter,
  wired into the main Agent in `sdk.ts`.

The override is deliberately off by default and must be enabled per
profile. The final-answer turn may still follow a tool turn and run at the
reduced level; the A/B probe must measure answer quality, not just speed.

## Consequences
- Tool-followup turns can run at e.g. "low" reasoning, cutting the dominant
  per-turn cost on long tool chains.
- 3 red-first tests (per-turn override behavior + fixed-level back-compat in
  the loop, settings getter read/default) — 107/107 across touched suites.
- Full ./test.sh: 4972 passed / 14 failed = documented sandbox known-fails
  only; biome + tsgo clean.
