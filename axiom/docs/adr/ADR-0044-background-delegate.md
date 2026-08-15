# ADR-0044 — Non-blocking (background) delegate mode

## Status
Accepted (2026-08-13)

## Context
The `delegate` tool (ADR-0029) runs helpers synchronously inside the tool
call: the parent turn blocks for the full helper run, up to the timeout
budget. Delegation-heavy work therefore stalls the parent even though the
whole point of delegation is to move work out of the parent's context.
Hermes runs top-level delegations in the background, with results
re-entering the conversation later.

## Decision
Add a pull-model background mode to the existing `delegate` tool:

- `background=true` returns immediately with a `handle` and a deterministic
  result-file path. The helper keeps running in its own process; the parent
  continues its turn.
- `BackgroundDelegateRegistry` (new module
  `extensions/delegate/background.ts`) owns the detached lifecycle: every
  path (success, error, timeout) stops the bridge exactly once and writes
  the compact result block to `<agentDir>/delegate-results/<handle>.json`;
  `session_shutdown` reaps anything still running (no orphans).
- Collection is pull, not push: `delegate(handle=..., waitMs=...)` returns
  the running status immediately (or waits up to `waitMs`), and returns the
  compact result block once settled; the result file is also directly
  readable. A background `tasks[]` batch starts one detached helper per task
  and returns one handle each.
- The blocking path (no `background`) is unchanged — back-compat.

Push delivery (injecting results into the parent session) is deliberately
out of scope: the extension API has no session message-injection seam, and
the file+handle pull model keeps the change small, testable, and honest
about its guarantees.

## Consequences
- Delegations no longer stall the parent turn; latency drops to the spawn
  cost.
- The model must remember to collect (tool description documents it);
  pull-based results add at most one round trip per collection.
- 9 new red-first tests (immediate return, result-file write, collect
  running/finished/wait, background timeout reaping, unknown handle, batch
  handles, session_shutdown reaping); the delegate suite is 39/40 green
  (1 live-gated).
