# ADR-0020: Discord gateway (third transport on `axiom gateway`)

**Status:** accepted (autonomous decision, owner-empowered, 2026-08-12)
**Relates to:** ADR-0017 (Telegram — the module-for-module template this reuses),
ADR-0016 (Signal — first transport), ADR-0001/0004/0006 (gateway architecture),
ADR-0015 (axiom baseline). First step of issue #3 "Gateway breadth —
more transports + continuity".

## Context

Issue #3 (Gateway breadth) asks for more transports. Telegram (ADR-0017) left a
clean seam: a `GatewayTransport` implementation consumed by the same `Gateway`
router, `CliCompletionRunner`, `JsonChannelIndex`, gateway commands, and sender
allowlist. Discord is the second HTTP transport to ride that same seam,
deliberately reusing the Telegram transport's shape rather than inventing a new
one. Like Telegram, a bot talks to api.discord.com over HTTPS with a Bot token
(no operator-side linked daemon). Unlike Telegram's single-offset `getUpdates`,
Discord has no "give me everything" long-poll; receive is a per-channel
`GET /channels/{id}/messages?after=<snowflake>` pull. Verified against a fake
client and a local HTTP server; the live bot pass is token-gated and stays an
operator follow-up (nothing fabricated).

## Decisions

1. **`--transport discord` joins the real selector.** `axiom gateway --transport
   discord` builds a `DiscordTransport` from `--discord-token` or
   `AXIOM_DISCORD_BOT_TOKEN`; an unknown value errors out and a missing token
   fails fast (never commit a token). The default transport stays signal.
2. **`DiscordClient` boundary.** `sendMessage` + `listChannels` (all
   message-capable channels the bot can see: DMs + guild text/news) +
   `getMessages(channelId, after)` with an optional `AbortSignal` so
   `disconnect()` aborts an in-flight pull. `HttpDiscordClient` is the real
   fetch-backed client (exercised against a local `node:http` server, never a
   live bot); tests inject a fake.
3. **Receive is per-channel cursor long-poll, no websocket (deliberate).**
   Each poll lists channels, then per channel pulls messages past the last
   delivered snowflake, delivers them newest-last, and advances that channel's
   cursor. This mirrors Telegram's offset ack and Signal's interval poll, stays
   dependency-free, and is deterministic to test. Trade-off, accepted: receive
   latency is bounded by `pollIntervalMs` (default 2000ms); low-latency websocket
   realtime is recorded as a follow-up.
4. **channelId = channel id; sender = author id.** Unlike Telegram (where both
   collapse to `String(chat.id)`), Discord's model has a real channel separate
   from the user. `channelId = String(channel_id)` drives the shared
   `JsonChannelIndex` (one Discord channel -> one session); `sender =
   String(author.id)` drives the shared config.json sender allowlist — the
   deny-before-model gate. A non-allowlisted author anywhere the bot can hear
   gets the router's canned denial, exactly as Telegram/Signal do.
5. **Per-channel isolation on poll.** A channel whose `getMessages` fails (403
   no access, 429 rate-limit, 5xx) is logged on one throttled line and skipped;
   delivery on every other channel continues. Only a 401 (bad bot token, any
   route) is fatal and stops the loop. This is stricter than Telegram's
   all-or-nothing batch because Discord fans out across many channels.
6. **Cursor persistence for no-replay.** After each cycle the per-channel
   cursors are persisted under `<AXIOM_HOME>/gateway/discord-cursor.json`, so a
   restarted gateway does not replay already-delivered messages.
7. **2000-char outbound chunking.** `create message` rejects text >2000;
   long agent replies are split into ≤2000 segments at the last whitespace at
   or before the limit (hard-split fallback), sent in order. This reuses the
   channel-agnostic chunker from the Telegram transport rather than duplicating
   it. A failing chunk logs and stops that batch — never silently dropped.

## Consequences

- `axiom gateway --transport discord [--discord-token X] --profile <name>`
  boots the gateway over Discord; `--help` documents it and the token env var.
- Data lives under `<AXIOM_HOME>/gateway/` (channel index, config allowlist,
  telegram-offset.json, discord-cursor.json), carrying the ADR-0015 data-cutover
  rules. Signal/Telegram paths are untouched and the default stays signal.
- Security posture in `--help`: allowlist the owner's Discord user id; a
  non-allowlisted author is denied before any model call (shared channels
  included — the deny reply is the router's existing behavior).
- **Known limitation (recorded, not built):** REST-poll receive means
  ~2s latency per message and enumerating every guild's text channels on each
  cycle can bump Discord's rate limit on huge shared servers. The single-owner
  DM surface is comfortably within limits; websocket realtime (`/` gateway
  intent) is the natural follow-up alongside Slack and the delivery ledger
  (issue #3's remaining scope).
- **Baseline drift (recorded):** this branch was cut from `baseline/prime-v0.7.2`
  @ 01948fe39 (ADR-0017 hardened telegram in HEAD). The baseline tip has since
  advanced to e1f071cbd (cron-gateway merge); a routine baseline merge brings
  this branch current under the AGENTS.md cadence.
- Live readiness needs the owner to: create a bot in the Dev Portal, enable the
  messages intent, put the token in `AXIOM_DISCORD_BOT_TOKEN` (or
  `--discord-token`), add their Discord user id to the allowlist, and point the
  completion runner at a working provider. Until then the gateway is exercised
  by its test suite (17 transport + 4 CLI + 3 router-over-Discord tests) and the
  live pass is the operator follow-up.
