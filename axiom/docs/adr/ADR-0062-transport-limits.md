# ADR-0062: Transport limits — Slack Socket Mode, all-transports fan-out, path audit

**Status:** accepted (autonomous decision, owner-empowered, 2026-08-15)
**Relates to:** ADR-0021 (Slack transport), ADR-0022 (delivery ledger +
fan-out), ADR-0023 (cross-transport fan-out), ADR-0001/0006 (gateway),
ADR-0057 (DNS/URL confinement patterns). Issue #40.

## Context

ADR-0021 shipped the Slack transport over REST long-poll and recorded Socket
Mode websocket realtime as a follow-up. ADR-0023 shipped cross-transport
fan-out but kept the default that a `deliverTo` entry without a `transport`
name goes to the active transport only — a broadcast on a multi-platform
gateway reaches the channel's own transport, not the others. Issue #40 pulls
both follow-ups together and asks for an honest inventory of which
Discord/Slack/Signal paths are real.

## Decisions

1. **Socket Mode receive behind an env gate; REST poll stays the default.**
   `SLACK_SOCKET_MODE=1` (or `true`) selects Socket Mode for the slack
   transport. It requires `AXIOM_SLACK_APP_TOKEN` (an app-level `xapp-`
   token; the bot token alone cannot open a socket connection), and the
   gateway fails fast without it. The bot token remains required — sends go
   over the REST client (`chat.postMessage`) exactly as on the poll path.
   Receive connects to the `apps.connections.open` url and drives the
   websocket: `events_api` frames are validated, delivered, and acked per
   envelope; `disconnect` frames close and reconnect (re-opening the link
   url, so a `refresh_disconnect_url` is honored).
2. **Socket Mode is an S-class receive surface with a permanent threat
   corpus.** Every frame is untrusted input until validated: JSON string
   under the size cap, non-empty string `envelope_id`, `event_callback` of
   `type === "message"` with non-empty string `user`/`text`/`channel`
   (channel and sender come from the event itself — no side-channel field
   can reroute a delivery). Each envelope id is delivered at most once
   (replay cache with a cap) while the ack stays idempotent. The socket url
   is confined to `wss:` on slack.com. Oversized frames are dropped unread.
   Tokens and `ticket=` query values are redacted from every log line. Nine
   attack cases (forged payloads, forged events, forged identities,
   malformed frames, replay, oversized frames, log leakage, forged url,
   forged channel override) are permanent tests in
   `test/gateway/slack-socket-threat.test.ts`.
3. **Broadcasts reach every active transport.** `deliverToAll` (and
   therefore `/announce`) changes the unnamed-target default: an entry
   without a `transport` name is delivered on EVERY transport the gateway
   holds — the primary plus every built fan-out sibling — each labelled by
   its own name in the ledger. Named targets keep ADR-0023 semantics exactly
   (named transport or degrade to the primary). This supersedes ADR-0023's
   "unnamed defaults to the active transport" wording; single-platform
   gateways are unchanged (the primary is the only transport).
4. **The path audit is a living document.** `docs/transport-audit.md` lists
   every Discord/Slack/Signal path with a status (live / built-not-live /
   paper) and the files implementing it. The close ritual for any future
   transport change updates that doc.

## Threat model

Defends against: a hostile or compromised Socket Mode connection - forged
events_api envelopes, forged event shapes, forged sender/channel identities,
malformed frames, replay of an already-delivered message, oversized frames,
app-token or ticket leakage into logs, forged socket URLs, and forged
channel overrides. The receive path validates shape and origin before any
dispatch and acks only envelopes it accepted. Fan-out broadcasts are
ledger-labelled per delivering transport so a misrouted send is auditable.

Deliberately not defended: TLS-level interception of the socket (delegated
to the platform's TLS), a compromised Slack app credential itself (the
attacker would be the platform), content-level prompt injection inside a
legitimate Slack message (the agent's own injection defenses apply
downstream), and live cross-platform fan-out verification (no second
platform credential in this sandbox - operator follow-up).

## Consequences

- `axiom gateway --transport slack` behavior is unchanged unless the
  operator opts into Socket Mode; the opt-in reads
  `SLACK_SOCKET_MODE` + `AXIOM_SLACK_APP_TOKEN` (or `--slack-app-token`).
- Operators with more than one platform built who use UNNAMED `deliverTo`
  entries now get a send on every platform for each such entry. To keep an
  entry single-platform, name its transport explicitly. The ledger labels
  every send with the delivering transport, so `/ledger` audits the real
  fan-out.
- Live Socket Mode and live cross-platform fan-out remain operator
  follow-ups (no Slack/Discord credentials in this sandbox); the gateway is
  exercised by its test suite until then.
- Test growth: new suites `slack-socket-transport.test.ts` (receive over a
  fake socket), `slack-socket-threat.test.ts` (9-case corpus),
  `transport-fanout.test.ts` (all-transports fan-out), and
  `gateway-socket-mode.test.ts` (env-gated selection); the ADR-0023
  cross-transport test in `gateway-ledger.test.ts` is updated to the new
  unnamed-target semantics.
