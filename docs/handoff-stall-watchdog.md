# Handoff: Session stall watchdog (ADR-0067, issue #44)

**Branch:** feat/session-stall-watchdog
**Date:** 2026-08-15
**State:** implemented, tested, ready for review

## What was built

Two hang detectors so no agent stalls silently (the 56-minute RLM child
incident that motivated issue #44).

### 1. Streaming stall watchdog (packages/agent)

- `AgentLoopConfig` gains `streamStallTimeoutMs` (no-data threshold, default
  120_000, 0 disables) and `streamStallMaxAttempts` (total attempts, default
  2 = one retry, clamped >= 1). `AgentOptions`/`Agent` expose both.
- `streamAssistantResponse` now runs provider calls in an attempts loop. Each
  attempt owns an `AbortController` linked to the parent abort signal and
  passed to the stream function, so an abort tears down the provider fetch.
  A per-`next()` timer aborts the attempt when no chunk arrives within the
  threshold (`raceWithStallTimeout`); the existing `raceWithAbort` onAbort
  closes the iterator. On a stall: partial state is popped, the stream
  function is re-invoked, and after the final attempt a `StreamStallError`
  ("Model generation stalled: no response data for …") is thrown. The `Agent`
  lifecycle converts that into a recorded failure message
  (`stopReason: "error"`, `errorMessage`), so the session shows it on resume.
- The timer only runs while awaiting the next chunk, so flowing generations
  are never cut. Parent aborts keep their existing aborted-message behavior;
  provider errors are rethrown unchanged (never retried as stalls).

### 2. RLM child liveness (packages/coding-agent)

- New `core/stall-watchdog.ts`: env knob parsing (non-negative ints, invalid
  falls back to default), `rlmChildSessionLastWriteMs` (newest mtime among a
  child session dir's direct files + `harness/`), `isRlmChildStalled`,
  `rlmChildStallRefreshMs` (quarter of the threshold, clamped [5s, 60s]).
- `RlmSubagentRegistryStatus` and `RlmChildAgentStatus` gain `"stalled"`.
  `rlm.list_subagents` (via `_buildRlmSubagentList`) projects running
  children whose session dir went quiet as `stalled`; the live
  `rlm_child_update` snapshots, the daemon agents-view roster
  (`rlmChildSnapshotForActiveSession`), and the context-tree glyph all show
  it. The run's lifecycle status stays `running`, so a child that writes
  again returns to `running`; cancellation stays a parent decision
  (`rlm.delete_subagent` works on stalled children).
- Running children get an unref'd periodic snapshot re-emit (refresh cadence
  above) so live views mark a stall without waiting for child events (a
  stalled child sends none). Cleared on cancel and on run settle.

### Env knobs

| Knob | Default | Meaning |
| --- | --- | --- |
| `AXIOM_STREAM_STALL_TIMEOUT_MS` | 120_000 | No-data threshold; 0 disables |
| `AXIOM_STREAM_STALL_MAX_ATTEMPTS` | 2 | Total attempts before a repeated stall fails the turn |
| `AXIOM_RLM_CHILD_STALL_MS` | 600_000 | No-write threshold marking a running child stalled; 0 disables |

Knobs are read at `Agent` construction (stream, in `sdk.ts`, the inline child
runtime, and `side-question.ts`) and at registry/snapshot build time (child),
so they apply to live processes without a restart.

## Verification

Unit-level only, red-first, fake timers/streams, no live model.

- `packages/agent/test/agent-loop-stall.test.ts` (8 tests): stall aborts +
  one retry keeps the retry answer; double stall rejects with
  `StreamStallError`; a 10-chunk/300s flowing generation is never cut; default
  timeout used when unset; parent abort still yields an aborted message; a
  provider error is not retried; timeout 0 disables; `Agent` records a
  failure message (`stopReason "error"`, message matches /stall/i).
- `packages/coding-agent/test/stall-watchdog.test.ts` (15 tests): env knob
  parsing (defaults, overrides, invalid fallback, zero), mtime scanning
  (direct files + harness subdir, missing/empty dir), stall classification
  (stale/fresh/disabled/no-proof), refresh cadence derivation.
- `packages/coding-agent/test/rlm-child-stall.test.ts` (6 tests): a real
  in-process `AgentSession` with a hanging child stream — registry marks
  `stalled` after backdating, returns to `running` on a new write, honors
  `AXIOM_RLM_CHILD_STALL_MS` and its zero-disable, re-emits `stalled`
  snapshots on the refresh cadence, and (end-to-end with the stream watchdog)
  a child whose model stalls twice ends with the failure recorded in its
  session file (`stopReason "error"`, /stall/i) and settles to `completed`.

Regression sweep on the touched areas: packages/agent 85/85, coding-agent
suites — agent-session-recursion 96, acp-rlm-subagents 97/97 combined run,
daemon-mode 191, daemon-session-list 29, context-tree 14, subagent-summary
9, system-prompt 25, refinement 62, kernel-rlm-heartbeat 3,
daemon-supervisor-lazy-subagents 15, agents-view-mode 20, heartbeat 10,
agent-session-runtime-model-fallback 3. biome clean (only the 2 documented
pre-existing telegram-transport useTemplate infos remain repo-wide); tsgo
clean in both packages.

Gotcha for future runs: vitest run directly from an RLM child session leaks
`RLM_DEPTH`/`RLM_MAX_DEPTH` into tests and breaks RLM-spawn tests with
"recursion depth limit reached" — scrub them (`env -u RLM_DEPTH -u
RLM_MAX_DEPTH`) or use `./test.sh` (parent runs the floor at merge).

## What is verified vs mocked

- Verified: watchdog logic, retry-once semantics, stall-vs-abort-vs-error
  classification, parent-abort preservation, session recording of the turn
  failure, registry/snapshot stall projection, env knob behavior.
- Mocked: all model behavior (fake streams, fake timers). No live provider
  call was made. The gateway path (ADR-0051) was studied but not changed.
