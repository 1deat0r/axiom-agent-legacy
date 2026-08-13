# Handoff — 2026-08-13 (parallel tool-call guidance + delegate spawn fix)

## Done
1. **P1 prompt guidance (ADR-0042)** — `buildParallelToolCallGuidance()` in
   `core/prompts/rlm.ts`; included in `buildRlmPrompt` and in the
   customPrompt path of `buildSystemPrompt`; "iterating one step at a time"
   reworded to "iterating until the task is done". 10 new red-first tests
   (`test/p1-guidance.test.ts`, 8 rlm + 2 customPrompt); snapshot test
   updated.
2. **RpcClient default cliPath fix** — `resolveDefaultCliPath(cwd)` tries
   `<cwd>/dist/cli.js`, then `<cwd>/packages/coding-agent/dist/cli.js`,
   falling back to the legacy default. Fixes the delegate tool dying with
   MODULE_NOT_FOUND when spawned from the monorepo root. 4 red-first tests
   (`test/rpc-client-cli-path.test.ts`).

## How it was verified
- P1: red run 8 failed/2 passed before implementation; 10/10 green after;
  full `./test.sh` 4961 passed / 14 failed = only documented sandbox
  known-fails (4603x4, 4685x9 EXDEV, daemon-serialized-refine x1);
  biome + tsgo clean.
- Bridge fix: 4/4 red then green; rpc suite regression 16/16; biome + tsgo
  clean; rebuilt dist. Delegate batch then ran 3 helpers successfully
  (deliverables in /tmp/p1-work/, repo untouched by helpers).
- Three delegate sub-agents did the P1 research (semantics audit, wording
  candidates, red tests); parent reviewed all artifacts before
  integrating.

## Notes
- The live gateway process still has the pre-fix module graph in memory;
  the rebuilt bundle is picked up by fresh completion children on the next
  message. A repo-root `dist/cli.js` symlink (gitignored) unblocks the old
  in-memory code until then; remove it after the gateway next restarts.
- Next: P2 segment planning in `executeToolCalls` (ADR follow-up), P3
  non-blocking delegate mode, P4 fast mode on tool turns.
