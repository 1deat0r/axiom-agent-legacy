# ADR-0017: Telegram gateway (second transport on `axiom gateway`)

**Status:** accepted (autonomous decision, owner-empowered, 2026-08-12)
**Relates to:** ADR-0016 (Signal gateway — the module-for-module template),
ADR-0001/0004/0006 (gateway architecture), ADR-0015 (prime-agent baseline).

## Context

ADR-0016 gave axiom its first living surface over Signal. Telegram is the
second transport on the same `axiom gateway` surface, mirroring the Signal
gateway module-for-module: a `GatewayTransport` implementation consumed by the
same `Gateway` router, `CliCompletionRunner`, `JsonChannelIndex`, gateway
commands, and the sender allowlist. Unlike Signal, Telegram needs no
operator-side linked daemon — a bot talks to api.telegram.org over HTTPS
(long-poll `getUpdates`, `sendMessage` outbound). Verified against a fake
client and a local HTTP server; the live bot pass is token-gated and stays an
operator follow-up (nothing fabricated).

## Decisions

1. **Transport selection becomes real.** `axiom gateway --transport
   signal|telegram` selects the transport at boot. This fixes the inert flag
   the Signal feature left: `--transport signal` was parsed but never read.
   `--transport telegram` builds a `TelegramTransport` from `--telegram-token`
   or `AXIOM_TELEGRAM_BOT_TOKEN`; an unknown value errors out and a missing
   token fails fast (never commit a token).
2. **`TelegramClient` boundary.** `sendMessage` + long-poll `getUpdates`
   (`offset`, `timeout` in SECONDS — the Bot API parameter, max 50; the
   transport converts its ms option at the boundary), with an optional
   `AbortSignal` so `disconnect()` aborts the in-flight poll. `HttpTelegramClient`
   is the real fetch-backed client (exercised against a local `node:http`
   server, never a live bot); tests inject a fake.
3. **channelId = sender = String(chat.id).** Private chats are positive ids and
   are allowlisted by the owner's personal chat id. Group/supergroup chats are
   negative ids that never match a positive-id allowlist, so they are denied by
   the existing router deny-before-model gate unless the group id is itself
   allowlisted. This is the deny-groups-by-default hardening.
4. **Offset ack with persistence.** After each batch, `offset = max(update_id)+1`
   is acknowledged and persisted under `<AXIOM_HOME>/gateway/telegram-offset.json`,
   so a crash/reboot does not replay up to 24h of unconsumed updates (no
   duplicate agent runs). Trade-off, accepted: offset ack on batch receipt is
   at-most-once delivery — a crash between `getUpdates` returning a batch and the
   router delivering it loses that batch (deliberately traded for no-replay).
5. **Errors: fatal vs transient.** Fatal (`error_code` 401 bad token, 409
   conflicting poll) stops the loop with a surfaced message on stderr.
   Transient (network/5xx/timeout) keeps polling from the same offset after a
   1s backoff, logging a throttled line (one per distinct error, so a stuck
   network / 5xx storm is visible without spamming). `HttpTelegramClient`
   surfaces the real `error_code` from the `ok:false` body so fatal
   classification is trustworthy. The long-poll timeout is converted to the
   Bot API's seconds parameter and clamped to its 50s max so an over-max value
   never goes on the wire. An offset-write failure warns on stderr and keeps
   polling (never silent).
6. **4096-char outbound chunking.** `sendMessage` rejects text >4096; long agent
   replies are split into ≤4096 segments (at the last whitespace at or before
   the limit, hard-split fallback for a giant unbroken token), sent sequentially
   in order. A failing chunk logs to stderr naming the chat and stops that batch
   — a failed send is never invisible or silently dropped.

## Consequences

- `axiom gateway --transport telegram --profile <name>` boots the gateway over
  Telegram; `--help` documents it and the token env var.
- Data lives under `<AXIOM_HOME>/gateway/` (channel index, config allowlist,
  telegram-offset.json), carrying the ADR-0015 data-cutover rules.
- Security posture documented in the CLI help: a public bot username plus a
  permissive allowlist is a real live-exposure risk; allowlist the owner's
  personal chat id (private chat). Deny a non-allowlisted chat before any model
  call; group chats (negative id) denied unless allowlisted.
- **Known limitation (recorded, not built):** a non-allowlisted group that
  messages the bot gets the same canned "private gateway" deny reply the router
  sends every denial (Signal included). Suppressing it for group chats would
  require chat-type on the shared `GatewayMessage` boundary (touching Signal
  too) — deferred, acceptable for a single-owner private-chat allowlist.
- Live readiness needs the owner to: create a bot with @BotFather, put the
  token in `AXIOM_TELEGRAM_BOT_TOKEN` (or `--telegram-token`), add their
  personal chat id to the allowlist, and point the completion runner at a
  working provider. Until then the gateway is exercised by its test suite (18
  transport + 4 router-over-Telegram + 9 CLI tests) and the live pass is the
  operator follow-up.
