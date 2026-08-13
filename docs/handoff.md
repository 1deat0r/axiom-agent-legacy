# Handoff — 2026-08-13 (parallel tool-calling: P1 guidance + P2 segment planner)

## Done
1. **P1 prompt guidance (ADR-0042)** — `buildParallelToolCallGuidance()` in
   `core/prompts/rlm.ts`, wired into `buildRlmPrompt` and the customPrompt
   path of `buildSystemPrompt`; "iterating one step at a time" reworded.
   10 red-first tests + snapshot update.
2. **P2 segment planning (ADR-0043)** — `planToolCallSegments` +
   segmented `executeToolCalls` in `packages/agent/src/agent-loop.ts`:
   a sequential-mode tool (ipython) now serializes only its own segment;
   parallel runs around it still execute concurrently, in emission order.
   7 red-first tests (4 planner + 3 behavioral).
3. **RpcClient default cliPath fix** — `resolveDefaultCliPath(cwd)`:
   delegate spawns work from the monorepo root (4 red-first tests).

## How it was verified
- All feature tests red-first, then green (agent-loop 41/41 incl. the
  pre-existing terminate/ordering/abort suites).
- Full `./test.sh`: 4960 passed / 15 failed = 14 documented sandbox
  known-fails (4603x4, 4685x9, daemon-serialized-refine x1) + 1
  kernel-attach-image flake that passes standalone 9/9.
- biome + tsgo clean. Dist rebuilt after each source change.

## Notes
- The live gateway keeps its old in-memory module graph until it restarts;
  fresh completion children pick up the rebuilt bundle on the next message.
  The gitignored repo-root `dist/cli.js` symlink unblocks the old code;
  remove after the next gateway restart.
- Remaining latency plan: P3 non-blocking delegate (background subagents
  whose results re-enter as agent messages), P4 fast mode on tool turns,
  then an A/B probe measuring turns-per-task before/after.
- Sub-agent fan-out proven again: 3 parallel read-only helpers produced
  the P1 research (semantics audit, wording, red tests) in /tmp/p1-work/.
