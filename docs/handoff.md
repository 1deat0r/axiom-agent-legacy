# Handoff — Gateway breadth: Discord + Slack transports + delivery ledger (feat/discord-gateway)

Status: ready for merge review. Branch `feat/discord-gateway`, cut from
`baseline/prime-v0.7.2` @ 01948fe39 (ADR-0017 hardened telegram in HEAD). Three
slices of issue #3 ("Gateway breadth — more transports + continuity") landed in
this isolated worktree: Discord (ADR-0020), Slack (ADR-0021), and the delivery
ledger + fan-out continuity (ADR-0022).

## What was done
- `src/gateway/transports/discord.ts` — DiscordTransport, DiscordClient
  (sendMessage/listChannels/getMessages), cursor stores, HttpDiscordClient
  (Bot, REST), chunk reuse (2000), fatal-401 + per-channel isolation.
- `src/gateway/transports/slack.ts` — SlackTransport, SlackClient
  (postMessage/listChannels/history), cursor stores, HttpSlackClient (Bearer,
  REST), chunk reuse (40k), ok:false fatal classification + inclusive-oldest
  no-replay + per-channel isolation.
- `src/gateway/delivery-ledger.ts` — Memory + File(JSONL) DeliveryLedger
  (ADR-0022), capped + malformed-line tolerant.
- `src/gateway/gateway.ts` — single `deliver()` path records every outbound
  delivery; `deliverToAll()` fans one message to every configured `deliverTo`
  channel.
- `src/gateway/config.ts` — `deliverTo?: { channel }[]` (back-compat).
- `src/gateway/commands/{announce,ledger}.ts` — `/announce <text>` +
  `/ledger [n]`, wired into the registry and /help.
- `src/cli/gateway-command.ts` — `--transport discord|slack`, tokens, help,
  buildTransport, and the CLI passes a FileDeliveryLedger + transport name.
- Tests: discord-transport (17), slack-transport (19), gateway-command (22),
  gateway-discord (3), gateway-slack (3), delivery-ledger (5), gateway-ledger
  (3), config deliverTo (+1). Full gateway dir 18 files / 143 tests.
- Docs: `docs/adr/ADR-0020/21/22*.md`, `docs/discord-gateway/summary.html`,
  this handoff.

## What was verified, and how
- **Unit (injected fakes):** per transport — send + chunk, deliver identity
  (channel + sender), per-channel cursor no-replay (incl. Slack's inclusive old-
  est), transient recovers, per-channel isolation (throttled), fatal stops,
  cursor-write failure warns+continues, disconnect aborts, skips blank. Ledger:
  JSONL append + continuity across instances + malformed-line tolerance + cap.
- **Mock (local node:http server, never live):** Http clients — right routes +
  auth (Bot/Bearer) + bodies (create-message, chat.postMessage, history, con-
  versations.list) + result parse + fatal surfaced.
- **Router (in-memory):** every outbound delivery (reply + denial) is recorded;
  deliverToAll fans out to each configured channel and records each; /ledger
  lists entries; /announce dispatches to deliverToAll.
- **CLI mock:** flag/env/missing-token resolution + buildTransport returns the
  right transport.
- **Floor:** biome check clean; root `tsgo --noEmit` clean; gateway dir 18
  files / 143 tests pass.

`./test.sh` reports 15 failures across 4451 tests — every one a pre-existing
*sandbox/environment* baseline daemon/worker suite, none touched by this work
(verified identical on a pristine baseline worktree: 4603 EXDEV +
daemon-serialized-refine; 4685 was FORCE_COLOR stderr noise and passes scrubbed;
kernel-heartbeat timing-flaky). Per AGENTS.md these are known-fails here
("record as known-fail with reason, never mute").

## Live (not done — operator-gated)
Real Discord, Slack, or Telegram needs tokens + owner ids in the allowlist + a
provider. Not fabricated; both transports are exercised by their test suites only.

## Notes / follow-ups
- Baseline tip advanced to e1f071cbd (cron-gateway merge) since this branch was
  cut; a routine baseline merge brings it current (AGENTS.md cadence).
- Issue #3 remaining scope: cross-platform multi-transport fan-out; the cron
  spine feeding `deliverTo` (once rebased onto the cron baseline); websocket /
  Socket Mode low-latency receive; the roadmap's relay/mirror + TTS consumer;
  and a live pass.
