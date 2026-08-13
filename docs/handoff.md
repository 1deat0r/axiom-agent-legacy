# Handoff — 2026-08-13 (parallel tool-calling: P1-P4 latency plan complete)

## Done
1. **P1 (ADR-0042)** — "# Parallel tool calls" prompt guidance in
   `buildRlmPrompt` + customPrompt path; "one step at a time" reworded.
2. **P2 (ADR-0043)** — `planToolCallSegments`: sequential-mode tools
   serialize only their own segment; parallel runs stay concurrent.
3. **P3 (ADR-0044)** — non-blocking delegate (`background=true` + handle
   collection + result files + session_shutdown reaping).
4. **P4 (ADR-0045)** — `toolTurnThinkingLevel`: opt-in reduced reasoning on
   tool-followup turns via a per-turn `getReasoningForTurn` loop hook.
5. **RpcClient default cliPath fix** — `resolveDefaultCliPath`.

## How it was verified
- Red-first throughout: agent-loop 43/43, delegate 39/40 (1 live-gated),
  settings-manager 40/40, system-prompt 35/35, rpc cli-path 4/4.
- Full `./test.sh`: 4972 passed / 14 failed = only documented sandbox
  known-fails (4603x4, 4685x9, daemon-serialized-refine x1).
- biome + tsgo clean. Dist rebuilt after source changes.

## Notes
- Enable P4 by adding `"toolTurnThinkingLevel": "low"` to the profile's
  settings.json (unset = off). Measure with the A/B probe before trusting it.
- Live gateway still runs its old in-memory module graph; fresh completion
  children pick up the rebuilt bundle next message. Remove the gitignored
  repo-root `dist/cli.js` symlink after the next gateway restart.
- Remaining: A/B probe (turns-per-task + answer-quality on a fixed
  workload, before/after the P1-P4 changes), then optionally Hermes-style
  path-conflict reservations + a concurrency cap (from the P1 semantics
  audit).
