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
- Unit/behavioral: test/gateway/active-model.test.ts (store round-trip, parse
  shapes, path, /model set/get/clear/usage), gateway.test.ts (threading the
  model into completions), completion.test.ts (argv injection). 45 model-
  feature tests green. tsgo --noEmit clean; biome clean.
- Notes: the two unrelated tests that fail on a fresh `main` branch still fail
  here (env-leak telegram-token guard — passes with the token scrubbed; and
  the mermaid `render.ts` subgraph-title defect, fixed separately on the
  mermaid-finish branch). Neither is a regression from this work.

## Live-path caveat (operator-gated)
- The end-to-end model CALL (real API/auth) is not exercised here — sandbox
  has no live keys. The seam is proven (flags reach the spawned CLI); the
  actual completion against `deepseek-v4-pro` needs an operator pass with a
  valid key. Unknown models surface as a completion error (CLI behavior).

## Remaining / next
- Optionally validate `/model` choices against a small catalog before saving
  (currently "try it and see" on next completion).
- Expose the active model in `/help` or a status line.
