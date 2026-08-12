# Handoff — Gateway `/model` hotswap (ADR-0033)

## What
Gateway-local `/model` command + a persisted per-profile active-model override
that the gateway injects (`--provider/--model`) into every subsequent agent
completion — the operator can switch the agent's model from Telegram, no
restart.

## Where (branch feat/gateway-model-hotswap, off main)
- `src/gateway/active-model.ts` — ActiveModelStore (file + in-memory), parse +
  path helpers. `{provider, model}` per profile at
  `<AXIOM_HOME>/gateway/model-<profile>.json`.
- `src/gateway/commands/model.ts` — `/model` (show), `/model <provider>
  <model>` / `provider/model` / `provider:model` / bare `<model>` (set),
  `/model clear`. Registered in commands/index.ts.
- `src/gateway/completion.ts` — `runCompletion` input gains `model?`;
  `CliCompletionRunner` appends `--provider` (when set) + `--model` to argv.
  `fakeCompletionRunner` now also records `model`.
- `src/gateway/gateway.ts` — `GatewayDeps.modelStore?`; read per profile and
  passed into each completion + into the command context.
- `src/cli/gateway-command.ts` — wires a `FileActiveModelStore` into the
  Gateway deps.

## Verified how
- Unit/behavioral: test/gateway/active-model.test.ts (store round-trip incl.
  provider-empty, clear removes the file, parse shapes, path, /model
  set/get/clear/usage), commands.test.ts (/help advertises /model and shows
  the active override), gateway.test.ts (threading provider+model AND bare
  model into completions across load()), completion.test.ts (argv injection
  with/without --provider). 49 gateway tests green (active-model 12, commands
  15, gateway 10, completion 12). tsgo --noEmit clean; biome clean;
  `./test.sh` floor green (see feature log).
- Fixes landed this session (see docs/feature-logs/model-hotswap.md): the
  store now round-trips a provider-empty override (bare `/model <model>` no
  longer vanishes on the next load()); `clear` removes the file instead of
  writing `{}`; `/help` shows the active-model status + `/model` usage.
- Carried (cherry-picked from feat/mermaid-render, where they also land): the
  mermaid subgraph title-role/border fix and the tui markdown-transform
  node:test conversion — two pre-existing main defects that broke the floor
  on any branch containing the mermaid merge.

## Live-path caveat (operator-gated)
- The end-to-end model CALL (real API/auth) is not exercised here — sandbox
  has no live keys. The seam is proven (flags reach the spawned CLI); the
  actual completion against `deepseek-v4-pro` needs an operator pass with a
  valid key. Unknown models surface as a completion error (CLI behavior).

## Remaining / next
- Optionally validate `/model` choices against a small catalog before saving
  (currently "try it and see" on next completion). Deliberately deferred: the
  CLI is the model authority; a gateway-side catalog would drift.
