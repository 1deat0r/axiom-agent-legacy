# Handoff: delegate helper env scrub (issue #26)

Branch `feat/delegate-env-scrub` (isolated worktree
`.worktrees/delegate-env-scrub`, cut from origin/main = 984f58d26). Never
touched the shared main tree. ADR not required (bug fix, per the issue).

## What was done

A delegate helper spawned from an RLM-harness session inherited
RLM_DEPTH, RLM_MAX_DEPTH, RLM_SESSION_DIR, RLM_GLOBAL_HARNESS_STATE_DIR,
RLM_HARNESS_STATE_DIR, and AXIOM_CODING_AGENT_DIR, because the bridge let
RpcClient merge process.env wholesale. The helper then emitted zero RPC
events and hung until the five-minute collectEvents timeout.

1. `packages/coding-agent/src/extensions/delegate/bridge.ts`: new
   `HELPER_ENV_SCRUB_KEYS` (the six variables above) and pure
   `scrubHelperEnv(env, extra)`. The bridge now ALWAYS passes
   `scrubHelperEnv(process.env, options.env)` as the RpcClient env instead
   of falling through to a wholesale process.env. Scrubbed keys are marked
   undefined; explicit `env` extras merge last, so a direct
   `createRpcClientBridge` caller can still deliberately override (escape
   hatch). The RLM_* subset matches the set ./test.sh unsets.
2. `packages/coding-agent/src/modes/rpc/rpc-client.ts`: `RpcClientOptions.env`
   widened to `Record<string, string | undefined>` with the contract
   "undefined entries unset the variable"; `start()` drops undefined
   entries after the process.env merge, so scrubbed keys never reach the
   helper env block (does not rely on Node's native undefined-drop).
3. `packages/coding-agent/test/extensions/delegate.test.ts`: new
   "helper env scrub" describe with four tests (three pure, one real
   spawn). The test.sh-sync test parses `../../../../test.sh` and asserts
   the RLM_* scrub subset equals the RLM_* set test.sh unsets, plus
   AXIOM_CODING_AGENT_DIR. The real-spawn probe test sets ambient
   RLM_DEPTH/AXIOM_CODING_AGENT_DIR, spawns a probe helper through the
   real bridge, and asserts the helper sees neither but sees explicit
   extras (PROBE_KEEP).

## What was verified

- 4 new tests red-first, then green; delegate suite 43 passed / 1 skipped
  (the skipped one is the pre-existing live-gated real-bridge test).
- rpc.test.ts (14 skipped live-gated), rpc-client-clone, rpc-client-refine
  green alongside the delegate suite.
- `npx biome check .`: clean on the three touched files. The whole-tree run
  still reports 2 pre-existing telegram-transport.test.ts useTemplate infos
  (documented in handoff-gateway-resilience.md) and 2 gh-tooling format
  drifts that landed with origin/main 984f58d26 (parallel session; not from
  this branch).
- `tsgo --noEmit` clean.
- Full ./test.sh from the worktree (AXIOM_PROJECT_ROOT unset): 5152 passed /
  14 failed - the 14 are EXACTLY the documented sandbox known-fails
  (daemon-serialized-refine x1, 4603-worker-recovery x4, 4685-daemon-client-
  modes x9 EXDEV hard-link), no regressions.

## Merge state

Branch pushed to origin; NOT merged (the shared main tree is busy with the
parallel session's uncommitted work, and main is checked out there).
Merge when the tree is free: fast-forward or merge feat/delegate-env-scrub
onto origin/main, then rebuild dist.

## Observations (follow-ups, not blockers)

- The live-gated test still passes `PI_CODING_AGENT_DIR` (vestigial name
  since the rebrand; the honored env is AXIOM_CODING_AGENT_DIR). Its helper
  isolation is silently ineffective. If it is updated to
  AXIOM_CODING_AGENT_DIR, the escape-hatch test confirms the explicit extra
  wins over the scrub.
- Live AC ("helper spawns from an RLM-harness session and emits RPC
  events") is covered by the live-gated test when API keys are present; the
  manual `env -u RLM_*` workaround already proved a scrubbed helper runs
  the full loop, and this branch makes that scrub automatic.
