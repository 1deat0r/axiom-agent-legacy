# Handoff — Discord gateway transport (feat/discord-gateway)

Status: ready for merge review. Branch `feat/discord-gateway`, cut from
`baseline/prime-v0.7.2` @ 01948fe39 (ADR-0017 hardened telegram in HEAD).

## What was done
Added a Discord transport to the axiom gateway, reusing the Telegram
transport's shape and wired into the SAME Gateway router, JsonChannelIndex, and
sender allowlist already shared by Signal + Telegram.

- `src/gateway/transports/discord.ts` — `DiscordTransport` (GatewayTransport),
  `DiscordClient` boundary (sendMessage / listChannels / getMessages),
  `MapDiscordCursorStore` + `FileDiscordCursorStore`, `HttpDiscordClient`,
  `chunkDiscordText` (reuses the Telegram chunker at the 2000 cap),
  `isFatalDiscordError` (401).
- `src/cli/gateway-command.ts` — `--transport discord`, `--discord-token`,
  `AXIOM_DISCORD_BOT_TOKEN`, `--help` + usage, `buildTransport` routing.
  Default transport stays signal; signal/telegram paths untouched.
- Tests: `discord-transport.test.ts` (17), `gateway-command.test.ts` +4 (18),
  `gateway-discord.test.ts` (3 — router over Discord author allowlist + channel
  index + command).
- `docs/adr/ADR-0020-discord-gateway.md`; `docs/discord-gateway/summary.html`;
  this handoff.

## What was verified, and how
- **Unit (injected fake DiscordClient):** send + chunking order/length ≤2000,
  deliver identity (channelId=channel, sender=author), per-channel cursor
  advance + no replay (persisted `discord-cursor.json` across runs), transient
  list failure keeps polling, per-channel 403 isolated (other channels +
  loop continue, one throttled log line), fatal 401 stops the loop, cursor-write
  failure warns + keeps polling, disconnect aborts in-flight getMessages,
  skips author/content-less messages.
- **Mock (local `node:http` server, never a live bot):** HttpDiscordClient hits
  the right routes with `Bot <token>` auth, sends the create-message body,
  parses getMessages, errors surface the HTTP status (401 -> fatal).
- **CLI mock:** discord flag/env/missing-token resolution + `buildTransport`
  returns a DiscordTransport.
- **Router (in-memory):** Discord author allowlist gates the model; channel
  index maps Discord channel -> session; commands handled locally.
- **Floor:** biome check clean; root + package `tsgo --noEmit` clean; full
  gateway dir 14 files / 108 tests pass.

`./test.sh` reports 15 failures across 4451 tests — every one is a pre-existing
*sandbox/environment* baseline daemon/worker suite, none touched by this change:
verified by running the same suites on a pristine baseline worktree (4603 EXDEV,
`daemon-serialized-refine` fail identically there; the 4685 stderr noise and the
kernel-heartbeat timeout were my shell's FORCE_COLOR + a timing flake — both pass
in a scrubbed/clean run). Per AGENTS.md the EXDEV suites are documented
known-fails in this sandbox ("record as known-fail with reason, never mute").

## Live (not done — operator-gated)
Real Discord needs: a bot + messages intent in the Dev Portal, the token in
`AXIOM_DISCORD_BOT_TOKEN`/`--discord-token`, the owner's Discord user id added
to `<AXIOM_HOME>/gateway/config.json` `senders`, and a working provider. Not
fabricated; the transport is exercised by its test suite only.

## Notes / follow-ups
- Baseline tip has advanced to e1f071cbd (cron-gateway merged) since this branch
  was cut; a routine baseline merge brings it current (AGENTS.md cadence).
- Issue #3 remaining scope (deliberately out of this first step): Slack
  transport, websocket low-latency receive, and the delivery ledger for
  one-run-to-many-channels fan-out.
