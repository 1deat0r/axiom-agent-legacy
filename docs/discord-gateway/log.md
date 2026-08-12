# Discord gateway — running log
Baseline: baseline/prime-v0.7.2 @ 01948fe39 (ADR-0017 hardened telegram in HEAD)
Goal: add a Discord transport reusing the Telegram transport's shape, wired into
the same channel index + sender allowlist (issue #3 "Gateway breadth" first step).

- [preflight] Scanned AGENTS.md/SOUL/CONTEXT + gateway router/transport/CLI wiring; confirmed HEAD carries hardened telegram (no reactions/HTML — uncommitted).
- [preflight] Worktree .worktrees/discord-gateway @ feat/discord-gateway; node_modules symlinked; baseline 36 gateway tests pass (scrubbed AXIOM_TELEGRAM_BOT_TOKEN).
- [plan] Plan v1 written; self-review found 2 weaknesses -> fixed (per-channel poll isolation; rate-limit/poll-interval determinism).
- [impl] discord.ts transport + boundary + stores written (REST long-poll, per-channel cursor, fatal/transient, chunk reuse).
- [impl] discord-transport.test.ts: 17 tests. Genuine red first: isolation test exposed 1ms-interval racing (channel recovered next cycle) -> hardened fake (permanent 403) + throttled-log assertion. Now green.
- [impl] gateway-command.ts: --transport discord + --discord-token + AXIOM_DISCORD_BOT_TOKEN + help/usage + buildTransport. gateway-command.test.ts +4 -> 18 green.
- [impl] gateway-discord.test.ts (router over Discord: author allowlist, channel index, command) -> 3 green.
- [floor] biome clean (autoformatted 3 files, removed a dead line); root+package tsgo --noEmit clean.
- [floor] Full gateway dir: 14 files / 108 tests pass. ./test.sh: 4451 tests, 15 fail — ALL env/known-fail baseline daemon suites (4603 EXDEV + daemon-serialized-refine fail identically on pristine baseline; 4685 was FORCE_COLOR stderr noise -> passes scrubbed; kernel-heartbeat timing-flaky). None gateway-related. Verified pre-existing on a throwaway baseline worktree.
- [review] Self-review of impl cold diff: no TODOs/dead/debug; edge cases (per-channel isolation, fatal/transient, no-replay, chunk, cursor-write failure, disconnect abort) all tested.
- [review] External review (skeptical-se): Correctness 5, Fit 5, Testability 5, Risk 4, Clarity 5 = 24/25 (96). Approved round 1.
- [docs] ADR-0020 written; handoff + summary.html generated from this log.

## Session 2 — Slack transport (issue #3, next slice; reuses Discord shape ADR-0021)
- [preflight] Slack API has a REST receive (conversations.list + conversations.history, cursor = message ts), so the same poll-per-channel shape is honest; ok:false bodies (like Telegram) drive fatal classification. Continued in the same isolated worktree.
- [impl] slack.ts transport + boundary + stores (SlackClient: postMessage/listChannels/history(ts cursor); ok:false fatal classification; 40k chunk reuse).
- [impl] slack-transport.test.ts red-first: 19 tests; the inclusive-oldest boundary (no-replay on resume) is genuinely asserted. Green.
- [impl] CLI wiring: --transport slack + --slack-token + AXIOM_SLACK_BOT_TOKEN + help/usage + buildTransport; gateway-command.test.ts +4 -> 22 green.
- [impl] gateway-slack.test.ts (router over Slack: user allowlist, channel index, command) -> 3 green.
- [floor] biome clean; root tsgo --noEmit clean; full gateway dir 16 files / 134 tests pass. Same pre-existing env/known-fail test.sh delta as session 1 (unrelated to gateway).
- [review] Self-review of impl cold diff: no TODOs/dead/debug; edge cases (inclusive oldest no-replay, per-channel isolation, fatal ok:false, transient 429, cursor-write failure, disconnect abort, missing user/text) all tested.
- [review] External review (skeptical-se): Correctness 5, Fit 5, Testability 5, Risk 4, Clarity 5 = 24/25 (96). Approved round 1.
- [docs] ADR-0021 written; handoff + summary regenerated from this log.

## Session 3 — Delivery ledger + fan-out continuity (ADR-0022)
- [plan] Scope: (a) delivery-ledger.ts (Memory + File JSONL), (b) Gateway records every outbound delivery + deliverToAll() fan-out to configured channels, (c) /announce + /ledger gateway-local commands, (d) config `deliverTo`. Commands stay sync (fire-and-forget fan-out) to avoid breaking the sync dispatch; cross-platform multi-transport fan-out + cron-spine feeding are documented follow-ups.
- [impl] delivery-ledger.ts (Memory + File JSONL, capped, malformed-line tolerant).
- [impl] gateway.ts: single deliver() path records every outbound delivery; deliverToAll() fans out to config deliverTo channels.
- [impl] config.ts deliverTo + types ctx ledger/deliverToAll; commands announce.ts + ledger.ts wired into registry + help; CLI passes FileDeliveryLedger + transportName.
- [impl] Tests red-first: delivery-ledger (5), config deliverTo (1), gateway-ledger (3). Full gateway dir 18 files / 143 tests green; biome clean; root tsgo clean.
- [review] Self-review of impl cold diff: no TODOs/dead/debug; edge cases (JSONL malformed line, memory cap, fan-out recipient blank, deny-path recorded, sync command dispatch preserved, back-compat config) all tested.
- [review] External review (skeptical-se): Correctness 5, Fit 5, Testability 5, Risk 4, Clarity 5 = 24/25 (96). Approved round 1.
- [docs] ADR-0022 written; handoff + summary regenerated from this log.

## Session 4 — routine baseline merge + cron spine feeds the ledger (ADR-0022)
- [merge] Merged baseline/prime-v0.7.2 (cron-gateway) into feat/discord-gateway: resolved 4 additive conflicts (types.ts, gateway.ts, commands/index.ts, gateway-command.ts). Gateway dir 19 files / 161 tests green; branch now current with baseline e1f071cbd.
- [impl] GatewayCron now records each scheduled-run delivery in the shared ledger (options ledger + transportName); CLI hoists ONE FileDeliveryLedger shared by Gateway + GatewayCron. Cron ledger tests +2. Full gateway dir 19 files / 163 tests green; biome + tsgo clean.

## Session 5 — cross-transport fan-out (ADR-0023)
- [plan] Schema: deliverTo entries may name a `transport` (default = active). Gateway holds extra named fan-out transports (send-only): deliverToAll routes each target to the named transport, ledger labelled per transport. CLI builds sibling transports from env tokens when present. Tests inject fake sibling transports (deterministic); cross-transport fan-out is real when multiple tokens are configured, inert-by-config otherwise (no dead code behind a fake).
- [impl] config deliverTo transport selector + types; gateway.ts transports map + per-target deliverVia (labelled by actual transport, unknown degrades to active); CLI buildFanOutTransports from present sibling tokens (send-only, never connected).
- [impl] Tests red-first: cross-transport routing + ledger labelling + unknown-target degrade + CLI sibling construction (gateway-ledger +2, gateway-command +2). Full gateway dir 19 files / 167 tests green; biome + tsgo clean. One real red->green: ledger must label the ACTUAL transport on unknown-target fallback (fix delivered).
- [review] Self-review: no TODOs/dead/debug; edge cases (unknown target degrade, phantom-name prevent, back-compat config, false sibling exclusion) tested.
- [review] External review (skeptical-se): Correctness 5, Fit 5, Testability 5, Risk 4, Clarity 5 = 24/25 (96). Approved round 1.
- [docs] ADR-0023 written; handoff + summary regenerated from this log.
