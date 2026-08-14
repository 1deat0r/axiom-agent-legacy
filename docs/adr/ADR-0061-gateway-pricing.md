# ADR-0061: Gateway cost model — priced by the ledger derivation, surfaced by /cost

Status: accepted
Date: 2026-08-15

## Context

The money thesis prices recorded tokens and never invents spend (ADR-0010).
Gateway-run completions were invisible to that model: the operator had no
cost surface on the gateway, and nothing defined whether gateway overhead
(HTTP calls, streaming edits, poll loops) counts as cost.

## Decision

1. **What is priced: completion tokens only.** A gateway run spawns one
   completion child per message; the child's channel session records token
   usage in the same session entries the ledger derivation prices. No new
   entry schema — the existing derivation covers gateway runs as it covers
   any session.
2. **What is not priced: gateway overhead.** HTTP, streaming, and polling
   cost nothing measurable. Pricing them would be invented spend (ADR-0010
   forbids it); the exclusion is documented, not hidden.
3. **The summary surface is the gateway `/cost` command** (plus a thin
   `axiom cost [<session-file>]` CLI mirror). Both show the session total,
   the lifetime total across every session (archived sessions included — a
   `/new` archive still holds cost), the per-run spend cap, and the model
   buckets. The channel session key follows the run path: channel-only when
   unanchored, channel:project:generation when anchored.
4. **Spend-cap semantics for gateway runs: per-run, inherited.** The child
   already enforces `maxRunCostUsd` (ADR-0011) per completion run — the
   gateway never adds a second cap, never blocks on its own. The cap line in
   `/cost` shows the configured value; hitting it stops the child before its
   next LLM call, and the reply reflects the stop. A persistent multi-run
   gateway budget is deliberately out of scope (a real feature needing a
   real store; it would be its own ADR).

## Consequences

- The gateway becomes honest about money: /cost shows exactly what the
  sessions show, priced the same way, with the same "no catalog price" notes.
- No new ledger storage exists; the derivation reads the same session files.
- Overhead stays invisible in cost (and documented as deliberately so).
