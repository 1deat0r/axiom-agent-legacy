# Plan — Discord gateway transport (issue #3, first step)

## Goal + assumption
Goal: `axiom gateway --transport discord [--discord-token X]` boots a
DiscordTransport reusing the Telegram transport's shape (typed client boundary,
poll-to-receive, persisted receive cursor, fatal/transient error split, outbound
chunking), wired into the SAME Gateway router, JsonChannelIndex, and sender
allowlist already shared by Signal + Telegram.

Success criterion: transport unit tests + CLI wiring tests + router-over-Discord
test green; `./test.sh`/biome/tsgo floor holds; ADR-0020 + handoff written.

Assumptions (explicit, reviewer-checked):
- A1. Discord receive is REST long-poll (getMessages per channel after a
  snowflake cursor), NOT websocket — mirrors Telegram's getUpdates long-poll,
  dependency-free; websocket low-latency is a documented follow-up.
- A2. channelId = Discord channel id; sender = Discord author id (snowflake
  string) — gated by the shared config.json `senders` allowlist, same as
  Telegram. channelId != sender (unlike Telegram) so the router's deny + channel
  index still work unchanged.
- A3. Transport polls every message-capable channel the bot can see (DM +
  guild text/news), like Telegram's "deliver everything, allowlist filters".
- A4. Delivery ledger / multi-channel fan-out / Slack: OUT of scope (issue says
  "First step: add a Discord transport").

## Files (create/change + intent)
- src/gateway/transports/discord.ts (new): DiscordClient boundary, cursor
  stores, DiscordTransport, HttpDiscordClient (REST, Bot auth). Chunking reuses
  the generic chunker from telegram.ts (alias, no duplicated logic).
- src/cli/gateway-command.ts (edit): --transport discord, --discord-token,
  AXIOM_DISCORD_BOT_TOKEN, help/usage, buildTransport + resolveGatewayStart.
- test/gateway/discord-transport.test.ts (new): chunking, deliver + sender
  identity, cursor advance/no-replay (+File store across runs), fatal-401 stops,
  transient keeps polling, per-channel failure isolated, disconnect, Http
  client local-server boundary (URLs, auth header, error status).
- test/gateway/gateway-command.test.ts (edit): discord flag/env/unknown/missing-
  token resolution + buildTransport returns DiscordTransport.
- test/gateway/gateway-discord.test.ts (new): router over Discord allowlist +
  session indexing + command (mirror gateway-telegram).
- docs/adr/ADR-0020-discord-gateway.md (new); docs/handoff.md (new);
  docs/discord-gateway/summary.html (from log).

## Ordered steps + verification
1. discord.ts transport + boundary + stores -> (test writes after; red via import).
2. discord-transport.test.ts -> implement to green; each assert is behavior.
3. gateway-command.ts wiring -> extend gateway-command.test.ts -> green.
4. gateway-discord.test.ts -> green.
5. ADR-0020 + help/usage consistency.
6. Floor: full ./test.sh + biome + tsgo in the worktree.

## Test strategy
New tests pin Discord-specific behavior (sender identity, cursor no-replay,
per-channel isolation, fatal-401). Generic router (allowlist deny, command-vs-
agent, serialization) already covered by gateway.test.ts + gateway-telegram.test.ts;
gateway-discord.test.ts pins the Discord identity semantics into the router.

## Risks
- R1. Discord rate limits under REST polling (enumerate + per-channel GETs).
  Mitigate: configurable pollIntervalMs (default 2000), filter to text-capable
  channel types only, document tradeoff. Determinism via injected interval.
- R2. One channel's GET failure must not abort delivery across others
  (403/rate-limit on a single channel). Per-channel try/catch, throttled log,
  skip-and-continue; only 401 is fatal.
- R3. Cursor JSON is single-writer under the gateway dir (same model as
  telegram-offset.json).
- R4. No websocket -> receive latency bounded by poll interval; documented.
- R5. Token hygiene: never commit a token; fail fast on missing token.
- Back-compat: gateway.ts / channel-index.ts / config.ts unchanged; default
  transport stays signal; telegram/signal paths untouched.
