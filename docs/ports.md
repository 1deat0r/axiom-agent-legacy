# Port queue: pi-fork axiom capabilities onto the prime-agent v0.7.2 baseline

ADR-0015 restarted axiom on prime-agent v0.7.2. The pi fork
(`archive/pi-v0.84.1`) carried four axiom capabilities pi lacked; ADR-0015's
decision is that they remain axiom-only and their prime-baseline ports are the
spine. Each row is its own work item (red-first on `baseline/prime-v0.7.2`).

## The spine (all four re-ported) — 2026-08-12

| # | Capability | Spec | What the prime baseline has / lacks | Status |
|---|---|---|---|---|
| 1 | **Cost ledger** — per-session + lifetime spend, override repricing, never-invented-spend, `/cost` | ADR-0010 | `/usage` is per-session display only; no lifetime ledger, no override table | **SHIPPED** (2026-08-12, 185bec2): `axiom-ledger` extension; adapted to v0.7.2 `Usage` (no `cacheWrite1h`; cacheWrite at own rate; usage on assistant messages only) |
| 2 | **Spend cap** — `maxRunCostUsd`, hard pre-call guard, `finishReason: 'cost_limit'` | ADR-0011 | `/goal` is a token budget, not a USD cap | **SHIPPED** (2026-08-12, 185bec2): guard rides turn_start/turn_end in `axiom-ledger` |
| 7 | **Memory tool** — durable facts, user/agent scopes, LRU eviction | ADR-0008 | refinement/harness is agent learning, not a user-facing memory tool | **SHIPPED** (2026-08-12, 185bec2): `axiom-memory` extension |
| 8 | **Profiles** — `--profile` separate homes, SOUL.md identity, never two processes | ADR-0014 | agent dirs exist per-home, but no `--profile` boot | **SHIPPED** (2026-08-12, 185bec2): `--profile` pre-scan sets AXIOM_HOME + `PRIME_AGENT_CODING_AGENT_DIR`; `axiom-profile` extension |

## Port mechanics (the restart's adaptations)

- Extension seam: `agent_settled` -> `agent_end` (v0.7.2 has no agent_settled).
- `InlineExtension {name,factory}` -> bare `ExtensionFactory`; `llama.cpp`
  dropped (removed upstream).
- Imports `.ts` -> `.js` (NodeNext).
- Env rename `PI_CODING_AGENT_DIR` -> `PRIME_AGENT_CODING_AGENT_DIR`
  (`ENV_AGENT_DIR` from config.ts), pinned by `profile-boot.test.ts`.
- Ledger pricing adapted to v0.7.2 `Usage` (no `cacheWrite1h`; cacheWrite at
  its own rate; toolResult/compaction/summary usage no longer recorded).
- Data cutover (ADR-0015): axiom-owned config/memory carry over via AXIOM_HOME;
  lifetime spend restarts at zero (derived from the new agent dir's sessions).

## Still ahead (from the pi fork's unfinished queue + the product spine)

- **Projects + root guard** (ADR-0014 port to the prime baseline): named
  workspaces inside a profile; per-project sessions/memory/ledger/cap; a
  zero-dep root guard on bash/read/write with plain-English escape approval.
- **Gateway + channel index** (ADR-0001/0004/0006, deferred in ADR-0013):
  platform transports + channel-to-session mapping — not yet on the map.

## Superseded by the prime baseline (do not port)

- TUI, session view, markdown, palette, input editor — prime-tui.
- Agent loop, sessions, providers, skills, compaction, RLM, subagents —
  prime coding-agent core.
- Reasoning-effort wiring — prime has per-model thinking levels.
- Per-session cost display — prime's `/usage` (the ledger above is the
  ported lifetime/override layer).
- Agent-learned harness state — prime's refinement.

## Culture that carries over regardless

- Red first, green after; honest verification (unit vs mock vs live never
  blurred).
- The money thesis: cost visible, spend capped, demonstrable agents.
  Client = profile, deliverable = project, budget = project cap (pending the
  projects port).
- ADR + handoff + tracker rituals; CONTEXT.md vocabulary.
