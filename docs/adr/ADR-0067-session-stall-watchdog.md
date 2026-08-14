# ADR-0067: Session stall watchdog (stream no-data abort and RLM child liveness)

**Status:** accepted
**Date:** 2026-08-15
**Extends:** ADR-0051 (gateway completion resilience), ADR-0039 (RLM subagents), ADR-0042 (parallel tool calls)
**Follows up:** ADR-0051 (gateway retry pattern, studied as reference; not duplicated)

## Context

An RLM child agent's model call stalled mid-generation and the child session
sat silent for 56 minutes with no detection anywhere: the provider stream
delivered no data, the child kept "running", and the parent only noticed when
the operator asked for status. Two detection gaps caused this:

1. **No stream-level stall detection.** The provider stream path
   (`packages/agent/src/agent-loop.ts` `streamAssistantResponse`) awaits the
   next chunk with no time bound. `timeoutMs` in the AI layer is an HTTP
   request timeout for SDKs that support it; once bytes are flowing, a
   mid-stream stall (socket half-open, upstream generation wedge) is invisible
   forever. The loop only honors the external abort signal
   (`raceWithAbort`/`isAbortError`), which nobody fires on a stall.
2. **No child liveness signal.** RLM children write their session JSONL, but
   nothing reads write activity. `rlm.list_subagents` reports a stalled child
   as `running` indefinitely, and the agents view does the same.

The gateway already has retry/timeout machinery for completion children
(ADR-0051, `src/gateway/completion-failure.ts`). That covers a child process
that *dies*; it does not cover a child process that *hangs*. This ADR closes
the hang gap without touching the gateway path.

## Decision

### 1. Streaming stall watchdog (packages/agent)

The seam is `streamAssistantResponse` in `packages/agent/src/agent-loop.ts`,
where provider chunks arrive as iterator events. The watchdog measures
**time since the last chunk**, never total generation time.

- `AgentLoopConfig` gains `streamStallTimeoutMs` (no-data threshold; default
  `120_000`; `<= 0` disables) and `streamStallMaxAttempts` (total attempts,
  initial + retries; default `2`, so one retry; clamped to `>= 1`).
- Each attempt creates its own `AbortController` linked to the parent abort
  signal and passes it to the stream function, so aborting the attempt tears
  down the provider fetch and stream. A per-`next()` timer aborts the attempt
  controller when no chunk arrives within the threshold; the existing
  `raceWithAbort(…, closeIterator)` path already closes the iterator on abort.
- On a stall (attempt controller aborted, parent not aborted): the attempt is
  closed, the partial message is popped from context, and the stream function
  is re-invoked. After the last attempt stalls again, a `StreamStallError`
  with a clear message is thrown, which the `Agent` lifecycle converts into a
  recorded failure message (`stopReason: "error"`, `errorMessage`), so the
  session shows the failure on resume instead of hanging.
- Parent aborts keep their existing behavior (aborted message via
  `finishAbortedMessage`); provider errors are rethrown unchanged and are
  never retried as stalls.
- Long generations with flowing tokens are never cut: the timer only runs
  while awaiting the next chunk, and every chunk resets it.

### 2. RLM child liveness (packages/coding-agent)

- New module `packages/coding-agent/src/core/stall-watchdog.ts` owns the env
  knobs and the pure staleness classifier.
- Child activity = newest mtime among the child session dir's direct files and
  its `harness/` subdir files (the session JSONL dominates; harness state
  writes count too). A missing/empty dir is never "stalled" (no proof).
- `RlmSubagentRegistryStatus` and `RlmChildAgentStatus` gain `"stalled"`.
  A child whose run status is `running` but whose session dir has had no
  writes for `AXIOM_RLM_CHILD_STALL_MS` (default `600_000` = 10 min) is
  reported as `stalled` by `rlm.list_subagents`, the live `rlm_child_update`
  snapshots, and the daemon agents-view roster. `delete_subagent` already
  exists for cancellation; nothing auto-cancels.
- The lifecycle status on the run itself stays `running`; `stalled` is a
  reporting projection, so a child that resumes writes returns to `running`.

### 3. Env knobs

| Knob | Default | Meaning |
| --- | --- | --- |
| `AXIOM_STREAM_STALL_TIMEOUT_MS` | `120_000` | No-data threshold for provider streams; `0` disables |
| `AXIOM_STREAM_STALL_MAX_ATTEMPTS` | `2` | Total attempts before a repeated stall fails the turn; `< 1` clamps to `1` |
| `AXIOM_RLM_CHILD_STALL_MS` | `600_000` | No-write threshold marking a running child stalled; `0` disables |

Values parse as non-negative integers; invalid values fall back to the
default (a watchdog must never crash the agent over a typo'd env var).
Knobs are read at agent construction (stream) and at registry/snapshot build
time (child), so they apply to live processes without a restart.

## Consequences

- A hung generation now fails within roughly `stall_timeout * attempts` and is
  visible in the session transcript; a hung child is visibly `stalled` and
  cancelable. Long generations are unaffected.
- One extra `AbortController` per turn and one timer per chunk; negligible.
- `streamStallTimeoutMs`/`streamStallMaxAttempts` are core-loop options, so
  every `Agent` (main, RLM children, side questions) inherits the watchdog
  through the shared constructor wiring in `sdk.ts`, the inline child
  runtime, and `side-question.ts`.
- No general generation-length limits, no auto-cancel of stalled children
  (cancellation stays a parent decision), no gateway changes. If the gateway
  path ever needs the same stall semantics, reuse the loop-level watchdog, not
  new machinery.
