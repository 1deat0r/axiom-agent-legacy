# ADR-0085: Dashboard — a read-only, on-demand, whole-profile report

**Status:** accepted
**Date:** 2026-08-15
**Issue:** #59 (ADR-0085 reservation)
**Implements:** ADR-0078 port order (dashboard, the final step)
**Extends:** ADR-0001 (gateway architecture: "observers (operators, dashboards)
attach the same way"), ADR-0010 (cost ledger), ADR-0061 (cost command),
ADR-0082 (session recall), ADR-0083 (channels + help discoverability),
ADR-0084 (cron spine)

## Context

The ADR-0078 port order ends with the dashboard. The capability was scoped in
a grilling session with the owner on 2026-08-15 (the settled scope is the
readiness contract on #59): the owner drives axiom mostly from the terminal
and second-most from Telegram, and wants one glance that answers "is anything
stuck, what happens next, what did it cost." Every store the report needs
already exists on the shared home — session files with persisted
recaps/verdicts (the daemon summarizer writes an `agent_status` entry per
turn), the shared cron store (ADR-0084), and the cost ledger (ADR-0010).

## Decision

1. **One shared aggregation module, two thin surfaces.** `core/dashboard.ts`
   builds a typed `DashboardReport` from the stores; `/dashboard` (gateway)
   and `axiom dashboard [--json]` (CLI, the primary surface) render it. Text
   on both surfaces; `--json` on the CLI prints the structured report.
   Registered in `/help` and pinned there by a test (ADR-0083).
2. **Three panels, in order.** Sessions (live first, then needs-input
   sessions always, then the five most recent by activity — each with its
   persisted recap and a needs-input flag); automation spine (every active or
   paused job in the shared cron store — gateway jobs, heartbeats, daemon
   schedule jobs — with schedule and a relative next-run, paused flagged);
   spend (one whole-profile lifetime number from the cost ledger's derivation,
   recorded tokens only, overrides applied). Completed and cancelled jobs
   have no future and are not shown.
3. **On-demand, read-only, global.** Every invocation scans the stores fresh;
   no cache, no daemon state, no writes. No project anchoring on either
   surface (the whole profile, always). Per-panel degradation: a missing or
   empty store renders a one-line notice and the other panels still render.
4. **Live marks are best-effort per surface.** The CLI probes the default
   daemon socket (the authoritative running set); the gateway marks channels
   with an in-flight run. An unreachable daemon means no live marks, never a
   failure — recency and needs-input flags carry the glance.
5. **The module is synchronous.** The gateway command dispatcher is sync (a
   contract pinned across every command test), so the sessions panel uses its
   own focused five-field scan (id, name, activity time, recap, verdict)
   instead of the async `readSessionInfo`: the dashboard never needs message
   contents, and the fields it reads are exactly the ones its tests pin. The
   CLI reuses the same sync path.
6. **Guardrails (CONTEXT.md terms).** The spend panel prices only recorded
   tokens (the ledger never invents spend); the dashboard is not a billing or
   usage surface. The raw-text boundary (ADR-0001) holds on the gateway.

## Consequences

- The daily driver gets the whole-fleet glance on both surfaces from one
  code path; the money thesis is visible in one number.
- No new state to drift, no new binary surface, so no live-verification
  catalog entry (ADR-0058): the four red-first pin families (core panels,
  gateway command, CLI command) cover the behavior in unit space.
- Deferred, recorded: a live/streaming surface, a web page, a cached
  aggregate (if the scan ever hurts), and a per-surface spend split. The
  existing `session_status` recaps already cover "watch" needs.
- `axiom status` keeps meaning "background service status"; the dashboard
  does not absorb or rename it.
- Verification: 40 tests across core dashboard, gateway commands, and the
  CLI command; the full floor runs at the merge.
