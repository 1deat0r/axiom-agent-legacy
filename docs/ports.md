# Port queue: from-scratch axiom capabilities onto the pi baseline

The from-scratch axiom (archived at `archive/from-scratch-v0.23`) built
capabilities that pi v0.84.1 does not have. Each row is one tracker issue
(one capability, red-first, on the baseline branch). Superseded rows are
closed — pi already covers them.

## Port (capabilities pi does not have)

| # | Capability | Source spec (archive) | What pi lacks | Notes |
|---|---|---|---|---|
| 1 | **Cost ledger** — per-session + lifetime spend, catalog pricing table with entry overrides, never-invented-spend, `/cost` | ADR-0010 | pi displays usage totals but has no restart-surviving session ledger or catalog-table pricing with overrides | pi's model catalog already carries per-model cost metadata — the ledger should read from it |
| 2 | **Spend cap** — `maxRunCostUsd`, hard pre-call guard, `finishReason: 'cost_limit'` | ADR-0011 | no spend cap at all | touches the agent loop; the highest-stakes port |
| 3 | **Provider catalog + connect wizard** — twelve-vendor catalog, key resolution (entry -> keyEnv -> env), boxed wizard | ADR-0009 | pi has provider config + a custom-provider extension point, but no wizard or catalog UX | pi's provider story is config-file driven; the wizard is the surface win |
| 4 | **Gateway + channels** — one channel maps to one session, transports (Telegram), resume index | ADR-0001/0004/0006 | no messaging gateway at all | pi's client/server RPC is process-to-process, not platform channels |
| 5 | **Memory eviction** — bounded memory, eviction policy | ADR-0008 | no eviction policy | pi has memory; eviction is the gap |
| 6 | **Context windowing** — windowed requests, atomic tool-call groups | ADR-0007 | pi has compaction; no windowing | decide: complement pi compaction or supersede |

## Superseded (pi covers it — do not port)

- TUI session view, frame, markdown-lite, palette, input editor — pi-tui
  (differential rendering, editor, overlays, themes, markdown).
- Line-mode TUI + lossless lineReader — pi's own input handling.
- Agent loop, sessions, memory, skills, providers — pi agent-core / ai /
  coding-agent.
- Reasoning-effort wiring — pi has thinking levels per model.
- Cost display — pi's usage totals (display only; the ledger above is the
  port).

## Culture that carries over regardless

- Red first, green after; honest verification (unit vs mock vs live never
  blurred).
- The money thesis: cost visible, spend capped, demonstrable agents.
- ADR + handoff + tracker rituals; CONTEXT.md vocabulary.
