# Context windowing: bounded per-request view, truncated-window, tool-group-safe

ADR-0007 records the decision for ticket #7: sessions grow without bound, and
every turn resends the full message history, so long conversations bloat the
prompt (cost + latency + quality drift). The owner authorized this decision
autonomously; this ADR documents the chosen strategy and the alternatives that
were weighed and rejected.

## Decisions

- **The window is a per-request view, not a mutation of the stored session.**
  Context windowing applies at the `buildMessages` seam in the agent loop —
  the exact place where the stored, clean history is assembled into the
  provider-bound message list (the same seam that already splices memory and
  skills context blocks). The persisted session keeps its full history; the
  window bounds only what reaches the model. This mirrors the established
  memory/skills philosophy ("the stored session keeps the clean, injection-free
  history; this is a per-request concern") and means enabling a window never
  destroys conversation data on disk.

- **Strategy: truncated window with a configurable message cap.** Add
  `maxContextMessages?: number` to `AgentConfig`. When set, `buildMessages`
  keeps the system prompt, the injected memory/skills context, and the **newest
  `maxContextMessages`** non-system messages; everything older is dropped from
  the request only. Unset (default) = today's unbounded behaviour, so existing
  callers are unaffected.

- **Tool-group safety.** A naive "drop oldest N" can sever an assistant
  tool-call message from its `tool` result messages, or orphan a `tool` result
  whose request was dropped — either produces a malformed conversation for the
  model. Truncation therefore never cuts through a tool-call group: an
  assistant message bearing `toolCalls` and its immediately-following `tool`
  result messages are treated as one atomic unit, all kept or all dropped.
  The cut point is the newest message boundary at or before the cap that does
  not split such a group (and always keeps the newest user message).

- **Memory/skills context is preserved when the window is hit.** The memory
  and skills blocks are injected after truncation, so durable facts and loaded
  skills survive a window regardless of how long the message history is. This
  is the whole point of separating "durable context" from "transient chat".

## Alternatives considered (and rejected)

- **Summarization.** Compressing the older tail with an LLM call keeps more
  signal but adds latency and cost on every truncated turn, introduces a
  failure mode (no provider / provider error mid-window), and makes behaviour
  non-deterministic. Overkill for the current codebase; can be layered on later
  as an enhancement once a window exists (it would slot in at this same seam).
- **Token-budget.** A true token budget needs a tokenizer (none in this
  codebase — would require an external dependency or approximation) and
  per-message token accounting. Usage stats (v0.10) report run totals, not a
  per-message budget, so a faithful budget is not yet feasible without more
  machinery. A message-count cap is deterministic, dependency-free, and
  bounding in the common case.
- **Surface-level windowing.** Truncating in the CLI/TUI/gateway would leave the
  core unbounded and split the policy across every surface. The core is the
  single correct seam (ADR-0002's lesson).

## Status

accepted

## Consequences

- Callers that want bounded prompts set `maxContextMessages`; the default
  preserves prior behaviour exactly.
- Full history remains persisted and recoverable (e.g. `/history`, session
  exports) even when the live prompt is windowed.
- A future summarization upgrade composes at the same seam without changing the
  stored-session contract.
