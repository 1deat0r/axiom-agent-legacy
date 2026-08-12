# Handoff — Delegate tool (feature #5, first step)

## What was done

Shipped the first step of feature #5 (Delegate + script-as-tool RPC) as an axiom `delegate` tool:
an RPC bridge that spawns an isolated helper process using the existing `--mode rpc` / `RpcClient`
infrastructure, runs one bounded task inside it, and returns to the parent session only a compact
result block `{ok, summary, tokens, cost, helper?, error?}`. The helper's intermediate tool calls and
full context never enter the parent session — a multi-step pipeline collapses into one
zero-context-cost turn, and the block reports only RECORDED tokens/cost (never-guess ledger ethos).

Files (branch `feat/delegate-rpc`, worktree `.worktrees/delegate-rpc`):
- `packages/coding-agent/src/extensions/delegate/{types,result,bridge,index}.ts`
- `packages/coding-agent/src/extensions/index.ts` (wired into `builtInExtensions`)
- `packages/coding-agent/test/extensions/delegate.test.ts`
- `docs/adr/ADR-0029-delegate-tool.md`, `docs/feature-logs/delegate-tool.md`,
  `docs/summary-delegate-tool.html`, `docs/plans/delegate-tool.md`

## What was verified, and how

- Neutral unit tests, stub bridge (no process, no keys): 22 passed, 1 skipped.
  `node <top>/node_modules/vitest/dist/cli.js --run test/extensions/delegate.test.ts` from
  `packages/coding-agent`. Covers: capSummary (no transcript), toDelegateResult ok/error/no-raw,
  empty-task rejection, compact ok block with recorded tokens/cost, error => ok:false + exactly-once
  stop, timeout (never-resolving stub) => ok:false + exactly-once stop (no orphan), per-call fresh
  bridge reset (built===2), model threading to the bridge, clamp NaN/Infinity/negative, parseModelRef.
- Type check: `tsgo --noEmit` clean. Lint: `biome check` clean on all changed files.
- Sensitive extension tests re-run (trigger-compact, compaction-extensions, interactive-mode-status):
  152 passed / 8 skipped, no regression.
- Live-gated real-bridge test (skipped in neutral suite — requires API keys, same gate as
  `rpc.test.ts`): spawns a genuine helper process and asserts a compact run result. Skipped here.

## The floor (./test.sh)

Run it before push; this branch has only the documented sandbox known-fails (EXDEV hard-link daemon
suites 4603/4685, daemon-serialized-refine) — no new regressions expected. Commits are green
per-step; push to origin `feat/delegate-rpc`.

## Not done (honest follow-ups)

- Propagate the parent's live provider/model selection (current: only an explicit `model` param).
- Pollute-free live cross-provider pass (operator-gated).
- Batch/parallel delegation, `async_delegation`, delegation_output_schema (later steps of #5).
- `helper.sessionId` / files written by the helper in the block.
