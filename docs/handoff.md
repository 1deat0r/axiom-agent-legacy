# Handoff — 2026-08-13 (parallel tool-calling: P1 guidance, P2 segments, P3 background delegate)

## Done
1. **P1 (ADR-0042)** — "# Parallel tool calls" prompt guidance in
   `buildRlmPrompt` + the customPrompt path; "one step at a time" reworded.
2. **P2 (ADR-0043)** — `planToolCallSegments`: a sequential-mode tool
   (ipython) serializes only its own segment; parallel runs around it still
   execute concurrently, in emission order.
3. **P3 (ADR-0044)** — non-blocking delegate: `background=true` returns a
   handle + result file immediately; `BackgroundDelegateRegistry` reaps
   helpers on success/error/timeout/session_shutdown; collect via
   `delegate(handle=..., waitMs=...)` or by reading the result file.
   Blocking path unchanged.
4. **RpcClient default cliPath fix** — `resolveDefaultCliPath` (delegate
   spawns work from the monorepo root).

## How it was verified
- Every change red-first, then green: agent-loop 41/41, delegate 39/40
  (1 live-gated skip), system-prompt 35/35, rpc cli-path 4/4.
- Full `./test.sh`: 4970 passed / 14 failed = only documented sandbox
  known-fails (4603x4, 4685x9, daemon-serialized-refine x1).
- biome + tsgo clean. Dist rebuilt after each source change.

## Notes
- Live gateway still runs its old in-memory module graph; fresh completion
  children pick up the rebuilt bundle next message. Remove the gitignored
  repo-root `dist/cli.js` symlink after the next gateway restart.
- Remaining: P4 fast mode / reduced thinking on tool turns, then an A/B
  probe measuring turns-per-task on a fixed workload (before/after the P1-P3
  changes).
- Sub-agent fan-out pattern proven twice: read-only helpers, deliverables
  in /tmp, parent integrates (P1 research in /tmp/p1-work/).
