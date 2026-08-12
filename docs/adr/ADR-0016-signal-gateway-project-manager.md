# ADR-0016: Signal gateway + project-manager assistant

**Status:** accepted (owner directive, 2026-08-12)
**Relates to:** ADR-0001/0004/0006 (gateway architecture, previously un-ported)
on the axiom v0.7.2 baseline (ADR-0015).

## Context

The from-scratch gateway (ADR-0001: one channel -> one Session, pluggable
Transports, gateway-local commands, raw-text boundary; ADR-0006: JSON channel
index) was never ported. Axiom's first living surface is: the agent, riding a
profile's SOUL.md, is reachable over **Signal** (via signal-cli); the user
messages it and it replies as a project manager — gateway-local commands manage
profiles (SOUL.md) and per-profile projects.

Verified: the gateway maps one Signal sender (number) to one persistent
session; per-message one-shot runs reuse the headless print-mode seam
(`axiom -p ...`); the CLI already loads the axiom built-in extensions and,
through `--profile`, sets AXIOM_HOME + the agent dir, so axiom-profile's
`before_agent_start` appends the profile's SOUL.md to the prompt. signal-cli is
operator-side (a linked device); the live link and a live provider are
operator/live-gated; tests fake the boundary.

## Decisions

1. **Gateway is a surface, not an extension.** `src/gateway/` boots a session
   runtime path via the real CLI (print mode), so it reuses all of main()'s
   setup (models, providers, extensions, profile env) instead of duplicating it.
2. **One sender = one session.** The channel index (ADR-0006) maps
   channelId -> a deterministic `gw-<hash>` session id; resume re-passes the id
   via `--session-id`.
3. **SOUL.md rides the prompt.** Per-message runs pass `--profile <name>`;
   the axiom-profile extension (already ported, ADR-0014/0015) appends the
   profile's SOUL.md on `before_agent_start`. Pinned by the existing profile
   suite + the completion argv contract.
4. **Commands are gateway-local.** `/help`, `/profiles` (list/create/switch),
   `/projects` (list/add/rm), `/soul` (view/set) never reach the model.
5. **Owner gate = sender allowlist.** `<AXIOM_HOME>/gateway/config.json`
   `{ senders: string[] }`. Non-listed senders get a canned denial before the
   model or commands. (Flat list doubles as command authority — acceptable for
   a single-operator first surface.)
6. **Per-channel serialization.** Runs on one channel are chained so two
   messages never interleave one session.
7. **Raw-text batch boundary.** Replies are sent once on completion
   (ADR-0001); Signal streaming per ADR-0004 is a follow-up.

## Consequences

- `axiom gateway [--profile <name>]` boots the gateway; `--help` documents it.
- Data lives under `<AXIOM_HOME>/gateway/` (channel index + config), carrying
  the ADR-0015 data-cutover rules.
- Live readiness needs the owner to: link signal-cli, add their number to the
  allowlist, and point the completion runner at a working provider. Until then
  the gateway is exercised by its test suite and the live pass is the follow-up.
