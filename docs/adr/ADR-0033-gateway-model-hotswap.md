# ADR-0033 — Gateway /model hotswap (switch the agent's model from Telegram)

## Status
Accepted (2026-08-13)

## Context
The Axiom gateway talks to the operator over Telegram (and other transports).
The operator wanted to switch the model the agent uses — e.g. to
`deepseek/deepseek-v4-pro` — from within the chat, without a gateway restart
or editing provider settings by hand. Today the model is fixed by the active
profile's provider configuration at spawn time; there is no operator-facing
way to change it for future completions.

## Decision
Add a gateway-local `/model` command (ADR-0001: commands never reach the
model) plus a persisted per-profile active-model override that the gateway
injects into every subsequent agent completion.

1. **ActiveModelStore** (`src/gateway/active-model.ts`): a tiny JSON store at
   `<AXIOM_HOME>/gateway/model-<profile>.json` holding `{provider, model}`.
   Load tolerates a missing/malformed file; save is a direct atomic write
   (mirrors the ledger/offset stores). Provider may be empty ("keep the
   profile's provider").
2. **`/model` command** (`src/gateway/commands/model.ts`): `/model` shows the
   current override; `/model <provider> <model>` (or `provider/model`,
   `provider:model`, or bare `<model>` to keep the provider) sets it; `/model
   clear` reverts to the profile default. It only writes the store — the 
   underlying CLI already accepts `--model` (and `--provider`), so no CLI
   change is needed.
3. **Injection**: `CompletionRunner.runCompletion` gains an optional `model`
   input; `CliCompletionRunner` appends `--provider <p> --model <m>` (provider
   only when set) to the spawned `axiom -p <prompt> --profile ...` argv. The
   router (`gateway.ts`) reads the store per profile and threads it into every
   run, so the swap applies to the very next message with no restart.

## Consequences
- Operator can switch the agent's model/feel from the chat (`/model ...`),
  persisted per profile, taking effect immediately.
- No gateway/core restart; no CLI changes; no new dependencies (the CLI's
  existing `--model`/`--provider` flags are used as-is).
- Model availability is validated by the CLI on the next completion (an
  unknown model surfaces as a completion error), matching how the CLI behaves
  today; the command does not ship its own model catalog.
- Provider-empty overrides let the operator retarget the model while keeping
  the profile's provider + key.

## Alternatives considered
- Spawning `axiom <model>` from a command per message: rejected — no
  persistence across messages and leaks the model-selection concern into the
  router.
- Editing provider settings on disk per switch: rejected — no operator
  surface, fragile concurrent writes.
- A model catalog in the gateway: rejected for now — the CLI is the model
  authority; a catalog would drift.
