# ADR-0021: Slack gateway (fourth transport on `axiom gateway`)

**Status:** accepted (autonomous decision, owner-empowered, 2026-08-12)
**Relates to:** ADR-0020 (Discord — the per-channel cursor template this
reuses), ADR-0017 (Telegram — the HTTP transport shape), ADR-0016 (Signal —
first transport), ADR-0001/0004/0006 (gateway architecture), ADR-0015
(prime-agent baseline). Issue #3 "Gateway breadth — more transports".

## Context

Issue #3 asks to add Discord and Slack cheaply behind the existing
`GatewayTransport` seam. The Telegram (ADR-0017) and Discord (ADR-0020)
transports left a proven shape: a typed HTTP client boundary, REST long-poll
receive with a persisted per-channel cursor, a fatal/transient error split, and
outbound chunking — all consumed by the same `Gateway` router, `JsonChannelIndex`,
and sender allowlist. Slack fits the same shape with two differences worth
recording: it has no "give me everything" websocket-free single endpoint the way
Telegram's getUpdates is, but it *does* offer REST per-channel history pulls
(`conversations.list` + `conversations.history`) that mirror Discord's
`getMessages` cursor model; and it reports errors as HTTP 200 with an `ok:false`
body (like Telegram's `ok:false`), not as HTTP status codes. Verified against a
fake client and a local HTTP server; the live pass is token-gated and stays an
operator follow-up (nothing fabricated).

## Decisions

1. **`--transport slack` joins the real selector.** `axiom gateway --transport
   slack` builds a `SlackTransport` from `--slack-token` or
   `AXIOM_SLACK_BOT_TOKEN`; unknown values error out and a missing token fails
   fast. The default transport stays signal; signal/telegram/discord paths are
   untouched.
2. **`SlackClient` boundary.** `postMessage` + `listChannels` (DMs + public/
   private channels via `conversations.list`) + `history(channel, oldest)`
   (via `conversations.history`) with an optional `AbortSignal` so
   `disconnect()` aborts an in-flight pull. `HttpSlackClient` is the real
   fetch-backed client (Bearer token, exercised against a local `node:http`
   server, never a live bot); tests inject a fake.
3. **Receive is a per-channel `ts`-cursor long-poll, no websocket.**
   `conversations.history` `oldest` is inclusive, so the transport delivers only
   messages with `ts` strictly greater than the stored cursor (exclusive
   semantics — a restart never replays the boundary message). Cursors persist
   under `<AXIOM_HOME>/gateway/slack-cursor.json`. Latency is bounded by
   `pollIntervalMs` (default 2000ms); Socket Mode websocket realtime is a
   follow-up.
4. **channelId = Slack channel id; sender = Slack user id.** `channelId =
   String(channel)` drives the shared `JsonChannelIndex` (one Slack channel ->
   one session); `sender = String(user)` drives the shared config.json sender
   allowlist — the deny-before-model gate. A non-allowlisted user anywhere the
   bot can hear gets the router's canned denial, exactly as the other transports.
5. **Fatal is an `ok:false` `error` field, not an HTTP code.** Slack returns
   HTTP 200 with `{"ok":false,"error":"invalid_auth"}` for API failures. The
   client surfaces the body's `error` (like Telegram's `error_code`); the
   fatal set is `invalid_auth, not_authed, account_inactive, token_revoked`
   (plus HTTP 401). Everything else (rate-limited 429, 5xx, per-channel
   `channel_not_found`) is transient: logged (throttled) and skipped per
   channel so every other channel still delivers.
6. **40,000-char outbound chunking.** `chat.postMessage` `text` caps at 40,000
   characters; long agent replies reuse the shared chunker at that cap. A
   failing chunk logs and stops that batch — never silently dropped.

## Consequences

- `axiom gateway --transport slack [--slack-token X] --profile <name>` boots
  the gateway over Slack; `--help` documents it and the token env var.
- Data lives under `<AXIOM_HOME>/gateway/` (channel index, config allowlist,
  telegram-offset.json, discord-cursor.json, slack-cursor.json), carrying the
  ADR-0015 data-cutover rules. Signal/Telegram/Discord paths are untouched.
- Security posture in `--help`: allowlist the owner's Slack user id; a
  non-allowlisted user is denied before any model call.
- **Known limitation (recorded, not built):** receive latency ~2s (no Socket
  Mode websocket); `conversations.history` returns recent messages only, so a
  channel with no recent activity contributes nothing new each poll (harmless).
  `chat.postMessage` renders `text` with Slack markdown, `<`/`>` are not escaped
  — a plain-code courtesy for the single-owner surface, and unescaping raw
  markdown is a possible follow-up. Slack/workspace visibility requires the bot
  be added to the channels it should hear.
- **Baseline drift (recorded):** the branch remains cut from
  `baseline/prime-v0.7.2` @ 01948fe39 (see ADR-0020); a routine baseline merge
  brings it current under the AGENTS.md cadence.
- Live readiness needs the owner to: create a Slack app with a bot token, add
  it to their channels, put the token in `AXIOM_SLACK_BOT_TOKEN` (or
  `--slack-token`), add their Slack user id to the allowlist, and point the
  completion runner at a working provider. Until then the gateway is exercised
  by its test suite (19 transport + 4 CLI + 3 router-over-Slack tests) and the
  live pass is the operator follow-up.
