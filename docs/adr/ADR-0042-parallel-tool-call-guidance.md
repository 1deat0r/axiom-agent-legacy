# ADR-0042 — Tell the model to batch independent tool calls (prompt guidance)

## Status
Accepted (2026-08-13)

## Context
The agent loop can execute multiple tool calls from one assistant message
concurrently (`executeToolCallsParallel`, `Promise.all` over the batch,
default `toolExecution: "parallel"`). In practice the concurrency never
fires: live session telemetry shows the model emits exactly one tool call
per assistant message, so each independent lookup costs a full model
round trip. A 10-lookup investigation became 10 sequential turns.

Two compounding causes:

1. The system prompt carries no batching guidance and even says to iterate
   "one step at a time" (`core/prompts/rlm.ts`), a residual sequential
   steer. Hermes ships an explicit "# Parallel tool calls" block (adapted
   from cline/cline#11514) that tells the model to emit independent calls
   together; it measurably collapses N round trips into one.
2. Verified runtime semantics constrain what the prompt may claim
   (findings from a read-only audit of `packages/agent/src/agent-loop.ts`,
   `core/tools/ipython.ts`, `core/tools/file-mutation-queue.ts`): a batch
   runs concurrently only when it contains no sequential-mode tool; ipython
   is the only sequential-mode tool, and one ipython call downgrades the
   whole batch to sequential (all-or-nothing). There is no concurrency cap
   and only the edit tool has file-conflict protection.

## Decision
Add a short, runtime-accurate "# Parallel tool calls" guidance block to the
model-facing prompt:

- `buildParallelToolCallGuidance()` in `core/prompts/rlm.ts` returns the
  block. It instructs emitting independent tool calls together in one
  response (the runtime executes them concurrently; one round trip instead
  of one per call), states the ipython exception (a batch containing an
  ipython call runs fully sequential, so fold shell work into one `%%bash`
  cell), and says to split calls across responses only when a later call
  depends on an earlier result.
- `buildRlmPrompt` includes the block and rewords "iterating one step at a
  time" to "iterating until the task is done" so the prompt no longer
  contradicts itself.
- `buildSystemPrompt` also appends the block in the customPrompt path, so
  sessions with custom system prompts (gateway profiles, anchored
  sessions) get the guidance too.

Follow-ups (not in scope): segment planning so a sequential-mode tool
serializes only itself, not the whole batch; a concurrency cap; file
mutation-queue coverage for bash (see the P1 semantics audit,
`/tmp/p1-work/semantics.md`).

## Consequences
- Fewer model round trips per task when the model batches independent
  calls; less latency and less resend cost on cache-cold providers.
- The prompt now claims only runtime-true behavior (ipython caveat
  included).
- Snapshot test `test/system-prompt.test.ts` updated for the new block and
  reworded line; 10 new tests in `test/p1-guidance.test.ts` (8 for
  buildRlmPrompt, 2 for the customPrompt path).
