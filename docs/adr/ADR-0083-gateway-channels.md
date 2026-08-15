# ADR-0083: Gateway channels capability — five transports, one fan-out

**Status:** accepted
**Date:** 2026-08-15
**Issue:** #57 (ADR-0083 reservation)
**Implements:** ADR-0078 port order (gateway channels, the step after session recall)
**Extends:** ADR-0001/0004/0006 (gateway architecture), ADR-0016 (signal),
ADR-0017 (telegram), ADR-0020 (discord), ADR-0021 (slack), ADR-0022
(delivery ledger), ADR-0023 (cross-transport fan-out), ADR-0058 (operator-gated
live verification), ADR-0062 (transport limits + Socket Mode)

## Context

The channels capability shipped before its record existed. Five transports
landed across the ADR series — signal (signal-cli shell-out), telegram
(HTTP long-poll + offset store), discord (per-channel cursor poll), slack
REST (ts-cursor poll), and Slack Socket Mode (app-token websocket, behind the
`SLACK_SOCKET_MODE` gate) — plus cross-transport fan-out (ADR-0023) and the
delivery ledger (ADR-0022). All are wired through `axiom gateway --transport`
in `gateway-command.ts`; missing tokens fail fast and unknown transport values
error. When the ADR-0078 spine issues were cut, #57 reserved ADR-0083 for the
record. The scoping note on #57 verified the live surface against the wiring
and found four gaps; this milestone closes them and records the capability.

## Decision

1. **The capability is the five transports plus fan-out and ledger, one CLI
   surface.** `axiom gateway --transport signal|telegram|discord|slack`
   selects the primary; `SLACK_SOCKET_MODE` + `AXIOM_SLACK_APP_TOKEN` opts the
   slack transport into Socket Mode. Fan-out siblings are built from present
   tokens (ADR-0023) and every delivery is ledgered with the delivering
   transport's name.
2. **Discoverability is pinned.** Every registered gateway command now appears
   in `/help`, and the pin is a test, not a convention: `/cost` was registered
   and dispatchable but absent from the help text (the scoping note's gap 1);
   it now has a help line and `cost-command.test.ts` pins it the same way the
   cron line is pinned.
3. **Socket Mode has a live-verification home.** The ADR-0058 catalog gains a
   `slack-socket-mode` check: `apps.connections.open` proves the app token is
   live and the websocket surface reachable — the surface the REST-only
   `gateway-delivery` check never touches. `docs/live-verification.md` gains
   the matching table row and an operator checkbox citing ADR-0062. The full
   socket receive round-trip stays the operator's manual pass.
4. **Signal fan-out is a recorded limitation, not a build.** Siblings are
   token-built (telegram/discord/slack) and signal is a linked device with no
   token, so signal can never be a `deliverTo` target. ADR-0023's known
   limitations now say so (the scoping note's gap 3); the owner chose
   record-only over a new presence gate and send-only wiring. If fan-out to
   signal is ever wanted, it is a one-issue follow-up.
5. **The deferred boundary stays honest.** The six operator-owned live passes
   (signal, telegram, discord, slack, fan-out, delegate) remain unticked in
   `docs/live-verification.md`; tokens are operator-owned, so the agent cannot
   close them. Closing the catalog/checklist gaps above is not the live pass —
   it is the home the live pass records into.

## Consequences

- One record now says what the channels capability is, what is live, and what
  is deferred — the ADR-0082 pattern applied to the gateway spine.
- The catalog is five checks: provider-chat, agent-run, rlm-kernel,
  gateway-delivery, slack-socket-mode. Skip-not-fail contract unchanged; a
  missing app token skips the new check with the reason named.
- The cron spine (`GatewayCron` + `/cron add|list|rm`, ADR-0022 note) is live
  and tested but deliberately NOT recorded here — #58 owns ADR-0084.
- Baseline drift (recorded): upstream merged at the milestone head
  (PrimeIntellect-ai/prime-agent 97b994c3d, the supervisor-owned RLM spawn
  ledger); floor green on the merged tree.
- Verification: 447 gateway tests green at scoping; this milestone adds the
  `/help` cost pin and the live-verification catalog test growth (19 tests);
  the full floor runs at the merge.
