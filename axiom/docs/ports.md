# Port queue: sovereign capabilities onto the Hermes baseline

ADR-0087 re-founded Axiom on Hermes Agent at HEAD. The capabilities Axiom grew
on pi (`archive/pi-v0.84.1`) and re-ported onto prime-agent
(`archive/prime-v0.7.2`, ADR-0015) now port again onto Hermes. Hermes already
ships much of what prime added, so this port is smaller than last time — and
the delta is what Hermes genuinely lacks.

## What Hermes already has (do not re-port)

- Memory tool with pluggable providers (`agent/memory_manager.py`,
  `plugins/memory/*`: honcho, mem0, supermemory, byterover, holographic,
  openviking, retaindb).
- Skills-from-experience and curation (`agent/learning_graph.py`,
  `agent/curator.py`, `tools/skill_provenance.py`, `tools/skill_manager_tool.py`).
- Subagents + MoA (`agent/subagent_lifecycle.py`, `agent/moa_loop.py`).
- Gateway + ~20 platforms, TUI, desktop, ACP (`acp_adapter/`), cron.
- Account-level billing (`hermes_cli/cli_billing_mixin.py`,
  `docs/billing-lifecycle.md`) — Nous Portal credits, not a token ledger.

## The sovereign spine (3V0 store-first layer → TypeScript)

The primary port (axiom/docs/handoff-sovereign-ts.md): 3V0's store-first
identity/memory/skills store, reimplemented in TypeScript against the
identical JSON schema, byte-compatible with 3V0's stores, shipped as a Hermes
plugin + CLI. The profile stays a derived view; the JSON store is canonical.

| # | Capability | Spec | Hermes has / lacks | Status |
|---|---|---|---|---|
| 1 | Store-first memory (memory.json) | 3v0/core/memory.py | memory tool exists (profile-derived); no canonical JSON + lineage | done |
| 2 | Skills store lineage (skills.json) | 3v0/core/skills.py | skill_manage exists; no versioned lineage store | done |
| 3 | native-store-bridge plugin, TS CLI backend | 3v0/plugin/ | plugin seam exists; re-point subprocess at node CLI | done |

## The cost spine (the money thesis)

| # | Capability | Spec | Hermes has / lacks | Status |
|---|---|---|---|---|
| 4 | Cost ledger — per-model token pricing, never-invented spend | ADR-0010 | covered by baseline: `agent/usage_pricing.py` prices every call from a per-model table (`_OFFICIAL_DOCS_PRICING` + provider models API), `normalize_usage`/`estimate_usage_cost` never invent (`unknown` status), `insights.py` renders cost buckets, `aux_accounting.py` prices aux LLM spend, all accumulated into `session_estimated_cost_usd` | covered by baseline |
| 5 | Spend cap — USD ceiling, hard pre-call guard | ADR-0011 | accumulator (`session_estimated_cost_usd`) exists; NO pre-call guard, no `--max-run-cost` flag, no `cost_limit` finish | done |

Note (2026-08-16): the port #4 premise above the fold ("account billing only; no
per-model ledger") was stale. Hermes's `agent/usage_pricing.py`, `agent/insights.py`,
and `agent/aux_accounting.py` already implement the ADR-0010 ledger, more completely
than the prime-era port (cache-read/write + reasoning token buckets, per-provider
route resolution, provider models API, honest `unknown` status). The genuine
remaining gap on the cost spine is #5 — the hard pre-call spend cap.

## Methodology synthesis (ADR-0087)

- **Hermes (chassis)**: keep the narrow waist + footprint ladder + learning
  loop. Add nothing to core an edge rung can carry.
- **Prime Agent (autonomy/durable state)**: RLM prompt-as-a-variable +
  Continual-Harness evidence-backed refinement. Hermes has subagents + a
  learning loop; harvest the discipline, not a rewrite.
- **DeepSeek Harness (composability)**: everything-is-a-plugin (Cordis).
  Sovereign capability ships as plugins/skills/CLI, never core surface.
- **Grok Build (build discipline)**: pinned toolchain + SOURCE_REV provenance
  + hermetic builds. Record the fork point (ADR-0087) and keep builds
  reproducible; ACP interop already exists in Hermes.

## Culture that carries over regardless

- Red first, green after; honest verification (unit vs mock vs live never
  blurred).
- The money thesis: cost visible, spend capped, demonstrable agents.
- ADR + handoff + tracker rituals; axiom/CONTEXT.md vocabulary.
