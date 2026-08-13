# ADR-0043 — Segment tool-call batches so one sequential tool serializes only itself

## Status
Accepted (2026-08-13)

## Context
ADR-0042 tells the model to batch independent tool calls in one response,
but the executor's gate was all-or-nothing: one `executionMode:
"sequential"` tool in a batch forced the entire batch through the
sequential path. ipython is the only sequential-mode tool, and axiom's
workflow is ipython-centric, so nearly every realistic batch would have
serialized completely — the concurrency the prompt now promises would
rarely materialize.

## Decision
Split each tool-call batch into maximal contiguous segments separated by
sequential-mode barriers, preserving emission order
(`planToolCallSegments` in `packages/agent/src/agent-loop.ts`):

- Parallel-capable calls (no `executionMode: "sequential"`, including
  unknown tools, as before) form parallel segments that execute via the
  existing `Promise.all` path.
- Sequential-mode calls form barrier segments that run one at a time; a
  later segment never starts before an earlier barrier completes, so
  side-effect ordering is identical to fully-sequential execution.
- `executeToolCalls` runs segments in order and concatenates results;
  the all-results-terminate rule (`shouldTerminateToolBatch`) is applied
  across the whole batch, unchanged.
- `config.toolExecution === "sequential"` still forces the legacy
  all-sequential path.

## Consequences
- A batch like [ipython, read, read] now runs ipython first and the two
  reads concurrently afterwards, instead of one at a time.
- `tool_execution_start` events for later segments fire after earlier
  segments complete (previously all starts fired before any execution) —
  a more truthful timeline for UI consumers.
- 7 new tests (4 planner unit tests, 3 behavioral: overlap after a
  barrier, emission-order gating, merge of adjacent barriers); the two
  pre-existing mixed-batch and terminate-rule tests still pin the old
  guarantees.
