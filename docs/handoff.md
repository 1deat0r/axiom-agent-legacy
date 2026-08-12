# Handoff — Gateway breadth: Discord + Slack transports (feat/discord-gateway)

Status: ready for merge review. Branch `feat/discord-gateway`, cut from
`baseline/prime-v0.7.2` @ 01948fe39 (ADR-0017 hardened telegram in HEAD). Two
slices of issue #3 ("Gateway breadth — more transports") landed back-to-back in
this isolated worktree: Discord (session 1, ADR-0020) and Slack (session 2,
ADR-0021), each reusing the Telegram/Discord per-channel-cursor shape and wired
into the SAME Gateway router, JsonChannelIndex, and sender allowlist.

## What was done
- `src/gateway/transports/discord.ts` — DiscordTransport, DiscordClient
  (sendMessage/listChannels/getMessages), cursor stores, HttpDiscordClient
  (Bot token, REST), chunk reuse (2000 cap), fatal-401 + per-channel isolation.
- `src/gateway/transports/slack.ts` — SlackTransport, SlackClient
  (postMessage/listChannels/history), cursor stores, HttpSlackClient (Bearer,
  REST), chunk reuse (40k cap), ok:false fatal classification + per-channel
  isolation + exclusive-ts no-replay.
- `src/cli/gateway-command.ts` — `--transport discord|slack`, `--discord-token`,
  `--slack-token`, `AXIOM_DISCORD_BOT_TOKEN`, `AXIOM_SLACK_BOT_TOKEN`, help +
  usage, buildTransport routing. Default stays signal; signal/telegram untouched.
- Tests: discord-transport (17), slack-transport (19), gateway-command +8 (22),
  gateway-discord (3), gateway-slack (3). Full gateway dir 16 files / 134 tests.
- `docs/adr/ADR-0020-discord-gateway.md`, `docs/adr/ADR-0021-slack-gateway.md`,
  `docs/discord-gateway/summary.html`, this handoff.

## What was verified, and how
- **Unit (injected fake clients):** per transport — send + chunk order/length,
  deliver identity (channel id + sender), per-channel cursor advance + no-replay
  (persisted cursor file across runs; Slack's inclusive `oldest` boundary is
  genuinely asserted as never replayed), transient list failure recovers, one
  channel's failure isolated (throttled log) while others + loop continue, fatal
  (Discord 401 / Slack ok:false invalid_auth) stops the loop, cursor-write
  failure warns + keeps polling, disconnect aborts in-flight pull, skips
  author/user-less or content-less messages.
- **Mock (local node:http server, never a live bot):** Http clients hit the
  right routes with the right auth (Bot / Bearer), send the right bodies
  (create-message, chat.postMessage, history `oldest`/`limit`, conversations.list
  `types`), parse results, and surface fatal statuses/errors.
- **CLI mock:** flag/env/missing-token resolution for both + buildTransport
  returns the right transport.
- **Router (in-memory):** author/user allowlist gates the model; channel index
  maps channel -> session; commands stay local.
- **Floor:** biome check clean; root + package `tsgo --noEmit` clean; full
  gateway dir 16 files / 134 tests pass.

`./test.sh` reports 15 failures across 4451 tests — every one a pre-existing
*sandbox/environment* baseline daemon/worker suite, none touched by this change
(verified identical on a pristine baseline worktree: 4603 EXDEV +
daemon-serialized-refine; 4685 was FORCE_COLOR stderr noise and passes scrubbed;
kernel-heartbeat timing-flaky). Per AGENTS.md these are known-fails here
("record as known-fail with reason, never mute").

## Live (not done — operator-gated)
Real Discord needs a bot + messages intent, token, owner user id in the
allowlist, provider. Real Slack needs an app + bot token, the bot added to
channels, owner user id in the allowlist, provider. Neither fabricated; both
transports are exercised by their test suites only.

## Notes / follow-ups
- Baseline tip advanced to e1f071cbd (cron-gateway merge) since this branch was
  cut; a routine baseline merge brings it current (AGENTS.md cadence).
- Issue #3 remaining: the delivery ledger (one run -> many channels), Socket
  Mode / websocket low-latency receive, and a live pass on both.
