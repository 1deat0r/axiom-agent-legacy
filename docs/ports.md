# Port queue: from-scratch axiom capabilities + new builds onto the pi baseline

The from-scratch axiom (archived at `archive/from-scratch-v0.23`) built
capabilities that pi v0.84.1 does not have. ADR-0014 adds the profiles +
projects + anti-drift phase. Each row is one tracker issue (one capability,
red-first, on the baseline branch). Superseded rows are closed — pi already
covers them.

## The spine (ports 1-2, then 7) — August

| # | Capability | Source spec | What pi lacks | Notes |
|---|---|---|---|---|
| 1 | **Cost ledger** — per-session + lifetime spend, catalog pricing table with entry overrides, never-invented-spend, `/cost` | ADR-0010 | pi displays usage totals but has no restart-surviving session ledger or catalog-table pricing with overrides | **SHIPPED** (2026-08-11, eef66f0): `axiom-ledger` extension, `/cost` + footer status, overrides via `~/.axiom/ledger.json`; 35 tests, 100% coverage |
| 2 | **Spend cap** — `maxRunCostUsd`, hard pre-call guard, `finishReason: 'cost_limit'` | ADR-0011 | no spend cap at all | **SHIPPED** (2026-08-11, b355ca5): per-run guard via turn_start + abort (pi has no `cost_limit` finish reason — the run stops as aborted with a warning); cap rides `~/.axiom/ledger.json`; per-project envelope builds on it (ADR-0014) |
| 7 | **Memory tool** — per-project memory store with eviction (pi has no memory tool at all) | ADR-0008 + from-scratch `core/memory.ts` | no memory tool | the "asks twice" fix; scopes per project (ADR-0014) |

## Profiles + projects (ports 8-9) — August (ADR-0014)

| # | Capability | Source spec | What pi lacks | Notes |
|---|---|---|---|---|
| 8 | **Profiles** — Hermes-model separate homes: SOUL.md + config + keys + memory + skills + sessions per profile; `--profile` boot; never two processes on one home | ADR-0014 | no profiles | profile SOUL.md rides the system prompt; implicit default profile |
| 9 | **Projects + root guard** — named workspace binding a root dir; per-project sessions/memory/ledger/cap; zero-dep root guard on bash/read/write with plain-English escape approval | ADR-0014 | implicit cwd grouping only, no named projects, no built-in root guard | pi's sandbox extension example proves the tool-replacement seam; OS sandbox = strict tier |

## The skin (assembly layer, after the spine)

Sidebar/project tabs, first-run onboarding wizard, preview pane, timeline
jump, per-project change summary — the Hermes-desktop feel in the terminal
(ADR-0014). Deferred past August unless the spine finishes early.

## Superseded (pi covers it — do not port)

- TUI session view, frame, markdown-lite, palette, input editor — pi-tui
  (differential rendering, editor, overlays, themes, markdown).
- Line-mode TUI + lossless lineReader — pi's own input handling.
- Agent loop, sessions, memory, skills, providers — pi agent-core / ai /
  coding-agent (memory is the exception: pi has skills but no memory tool,
  hence port #7).
- Reasoning-effort wiring — pi has thinking levels per model.
- Cost display — pi's usage totals (display only; the ledger above is the
  port).

## Culture that carries over regardless

- Red first, green after; honest verification (unit vs mock vs live never
  blurred).
- The money thesis: cost visible, spend capped, demonstrable agents.
  Client = profile, deliverable = project, budget = project cap.
- ADR + handoff + tracker rituals; CONTEXT.md vocabulary.
