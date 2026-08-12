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
