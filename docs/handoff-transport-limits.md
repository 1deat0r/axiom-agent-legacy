# Handoff: transport limits (issue #40, ADR-0062)

**Branch:** feat/transport-limits
**What was done:**

1. **Slack Socket Mode receive** (`packages/coding-agent/src/gateway/transports/slack-socket.ts`).
   `SlackSocketTransport` receives over the Socket Mode websocket
   (`apps.connections.open` link -> `events_api` frames -> per-envelope ack)
   and sends over the REST client. Env-gated: `SLACK_SOCKET_MODE=1` (or
   `true`) plus `AXIOM_SLACK_APP_TOKEN` (or `--slack-app-token`); REST poll
   stays the default. The gateway fails fast when Socket Mode is on but the
   app token is missing. `HttpSlackClient.appsConnectionsOpen` added in
   `slack.ts`; CLI wiring in `gateway-command.ts`.
2. **Multi-transport fan-out** (`gateway.ts` `deliverToAll`): unnamed
   `deliverTo` entries now broadcast to every active transport (primary +
   every built fan-out sibling), each ledger-labelled by its own name.
   Named entries keep ADR-0023 semantics. `/announce` help and docs updated.
3. **Audit doc** `docs/transport-audit.md`: every Discord/Slack/Signal path
   with status live / built-not-live / paper, files cited.

**Verified (unit, fakes only):**
- New eval suites, all green: `slack-socket-transport.test.ts` (14),
  `slack-socket-threat.test.ts` (9 attack cases),
  `transport-fanout.test.ts` (5), `gateway-socket-mode.test.ts` (7).
  Full `test/gateway/` directory: 409 passed / 0 failed.
- RED evidence: before the change the four suites failed — socket suites on
  the missing module, the fan-out suites on the old single-transport
  semantics (captured in `/tmp/axiom-worktrees/transport-limits-red.log`).
- `biome check .` clean (only the 2 pre-existing infos in
  telegram-transport.test.ts, unchanged from the base commit); `tsgo
  --noEmit` exit 0.
- The corpus caught a real transport defect during development: frame
  handlers were installed after the open handshake, so a frame arriving at
  open was dropped; fixed by installing handlers before awaiting open.

**Not done / operator follow-ups:**
- Live Socket Mode run (needs a Slack app + app token; no credentials in
  this sandbox) — the acceptance criteria's operator step.
- Live cross-platform fan-out (needs a second platform's token).
- The full `./test.sh` floor was NOT run here; the parent runs it at merge
  time (worktree rule).
