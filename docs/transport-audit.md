# Transport audit: Discord, Slack, Signal (issue #40, ADR-0062)

Honest inventory of every Discord, Slack, and Signal path in the codebase,
with its status. Statuses:

- **live** — running in production on this box (the gateway unit boots it).
- **built-not-live** — implemented and unit-tested, but never booted live
  here (no credentials / no operator run yet).
- **paper** — documented as a follow-up or limitation, not implemented.

As of this audit (2026-08-15): only **Telegram is live**
(`axiom-telegram-gateway.service`, `--transport telegram`). No Discord or
Slack bot token and no linked Signal account are configured, so every
Discord/Slack/Signal row below is **built-not-live** unless marked otherwise.
Files are cited relative to `packages/coding-agent/`.

## Slack

| Path | Files | Status | Notes |
| --- | --- | --- | --- |
| CLI selection (bot token required, fail-fast) | `src/cli/gateway-command.ts` (`resolveGatewayStart`, `buildTransport`) | built-not-live | `--transport slack` + `--slack-token` / `AXIOM_SLACK_BOT_TOKEN` |
| REST long-poll receive (per-channel ts cursor) | `src/gateway/transports/slack.ts` (`SlackTransport`) | built-not-live | Default receive path; `conversations.list` + `conversations.history`, exclusive cursor so a restart never replays the boundary message |
| REST send + 40,000-char chunking | `src/gateway/transports/slack.ts` (`SlackTransport.send`, `chunkSlackText`) | built-not-live | Reuses the channel-agnostic chunker at the Slack text cap |
| Fatal vs transient classification | `src/gateway/transports/slack.ts` (`isFatalSlackError`, `FATAL_SLACK_ERRORS`) | built-not-live | `ok:false` body errors: `invalid_auth` etc. fatal; 429/5xx/per-channel transient |
| Cursor persistence | `src/gateway/transports/slack.ts` (`FileSlackCursorStore`) | built-not-live | `<AXIOM_HOME>/gateway/slack-cursor.json` |
| HTTP client (Bearer bot token) | `src/gateway/transports/slack.ts` (`HttpSlackClient`) | built-not-live | Exercised against a local `node:http` server in tests, never a live bot |
| Socket Mode receive (websocket) | `src/gateway/transports/slack-socket.ts` (`SlackSocketTransport`) | built-not-live | New in ADR-0062. Env-gated: `SLACK_SOCKET_MODE=1` + `AXIOM_SLACK_APP_TOKEN`; REST poll stays the default |
| Socket Mode send (REST via bot token) | `src/gateway/transports/slack-socket.ts` (`SlackSocketTransport.send`) | built-not-live | Same chunking as the poll transport |
| Socket Mode link open | `src/gateway/transports/slack.ts` (`HttpSlackClient.appsConnectionsOpen`) | built-not-live | `apps.connections.open` with the app-level (xapp-) token |
| Socket Mode threat mitigations | `src/gateway/transports/slack-socket.ts` (frame validation, replay cache, url confinement, secret redaction, oversized-frame drop) | built-not-live | 9-case corpus in `test/gateway/slack-socket-threat.test.ts` |
| Connectors menu (status / set token / Use now) | `src/gateway/connectors.ts`, `src/cli/gateway-service.ts` | built-not-live (slack) | The menu itself is exercised by unit tests |
| Fan-out to a slack channel | `src/gateway/gateway.ts` (`deliverToAll`), `src/cli/gateway-command.ts` (`buildFanOutTransports`) | built-not-live | Built only when a Slack token is present; ledger labels the delivering transport |
| Sender allowlist gate | `src/gateway/gateway.ts` (`handle`), `src/gateway/config.ts` (`loadGatewayConfig`) | built-not-live (slack) | Deny-before-model; live for Telegram |

## Discord

| Path | Files | Status | Notes |
| --- | --- | --- | --- |
| CLI selection (bot token required, fail-fast) | `src/cli/gateway-command.ts` (`resolveGatewayStart`, `buildTransport`) | built-not-live | `--transport discord` + `--discord-token` / `AXIOM_DISCORD_BOT_TOKEN` |
| REST long-poll receive (per-channel snowflake cursor) | `src/gateway/transports/discord.ts` (`DiscordTransport`) | built-not-live | `GET /channels/{id}/messages?after=<cursor>` |
| REST send + 2,000-char chunking | `src/gateway/transports/discord.ts` (`DiscordTransport.send`, `chunkDiscordText`) | built-not-live | |
| Cursor persistence | `src/gateway/transports/discord.ts` (`FileDiscordCursorStore`) | built-not-live | `<AXIOM_HOME>/gateway/discord-cursor.json` |
| HTTP client (Bot token) | `src/gateway/transports/discord.ts` (`HttpDiscordClient`) | built-not-live | Exercised against a local `node:http` server in tests |
| Connectors menu | `src/gateway/connectors.ts`, `src/cli/gateway-service.ts` | built-not-live (discord) | |
| Fan-out to a discord channel | `src/gateway/gateway.ts` (`deliverToAll`), `src/cli/gateway-command.ts` (`buildFanOutTransports`) | built-not-live | |
| Sender allowlist gate | `src/gateway/gateway.ts` (`handle`), `src/gateway/config.ts` (`loadGatewayConfig`) | built-not-live (discord) | Deny-before-model |

## Signal

| Path | Files | Status | Notes |
| --- | --- | --- | --- |
| CLI selection (no token; signal-cli flags) | `src/cli/gateway-command.ts` (`resolveGatewayStart`, `buildTransport`) | built-not-live | Default transport when `--transport` is absent; `--signal-cli`, `--signal-account` |
| Receive (poll `signal-cli receive --json`) | `src/gateway/transports/signal.ts` (`SignalTransport`) | built-not-live | The binary is installed (`~/.local/bin/signal-cli`); no linked account on this box |
| Send (`signal-cli send`) | `src/gateway/transports/signal.ts` (`SignalTransport.send`) | built-not-live | |
| signal-cli client boundary | `src/gateway/transports/signal.ts` (`CliSignalClient`) | built-not-live | |
| Connectors menu (link guide / Use now) | `src/gateway/connectors.ts`, `src/cli/gateway-service.ts` | built-not-live (signal) | |
| Sender allowlist gate | `src/gateway/gateway.ts` (`handle`), `src/gateway/config.ts` (`loadGatewayConfig`) | built-not-live (signal) | channelId = sender = phone number |

## Cross-platform

| Path | Files | Status | Notes |
| --- | --- | --- | --- |
| `/announce` + `deliverToAll` broadcast | `src/gateway/commands/announce.ts`, `src/gateway/gateway.ts` (`deliverToAll`) | live (telegram path) | ADR-0062: named targets reach their transport; unnamed targets reach every active transport (primary + siblings) |
| Per-transport ledger labelling | `src/gateway/delivery-ledger.ts`, `src/gateway/gateway.ts` (`deliverVia`) | live | `/ledger` shows which transport really delivered |
| Cron delivery | `src/gateway/cron.ts` (`GatewayCron.runJob`) | live (telegram) | Single active transport; not a broadcast |
| Router deny-before-model | `src/gateway/gateway.ts` (`handle`) | live | Sender allowlist gates every transport |

## Paper

| Item | Recorded in | Notes |
| --- | --- | --- |
| Slack Socket Mode live run | ADR-0062 / issue #40 | Operator follow-up: create the Slack app, set `SLACK_SOCKET_MODE=1` + `AXIOM_SLACK_APP_TOKEN`, allowlist the owner's Slack user id |
| Cross-platform live fan-out verification | ADR-0023 (known limitations) | Built; needs tokens for a second platform to exercise live |
| Relay/mirror continuity across transports | ADR-0023 (known limitations) | Documented follow-up, not implemented |
| Slack outbound markdown unescaping | ADR-0021 (known limitation) | `chat.postMessage` renders Slack markdown; raw markdown is not unescaped |

## Test coverage per path

- Slack poll transport: `test/gateway/slack-transport.test.ts`, router path `test/gateway/gateway-slack.test.ts`
- Slack Socket Mode: `test/gateway/slack-socket-transport.test.ts` (fake socket), threat corpus `test/gateway/slack-socket-threat.test.ts` (9 attack cases)
- Socket Mode selection: `test/gateway/gateway-socket-mode.test.ts`
- Discord: `test/gateway/discord-transport.test.ts`, `test/gateway/gateway-discord.test.ts`
- Signal: `test/gateway/signal-transport.test.ts`
- Fan-out: `test/gateway/transport-fanout.test.ts`, `test/gateway/gateway-ledger.test.ts`, `test/gateway/gateway-command.test.ts`
