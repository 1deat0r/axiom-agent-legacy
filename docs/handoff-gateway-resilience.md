# Handoff: gateway completion resilience (ADR-0051)

Branch `fix/gateway-resilience` (isolated worktree `.worktrees/gateway-resilience`,
cut from origin/main = 2bbdc2f0e). Never touched the shared main tree.

## What was done

The 2026-08-14 16:38 Telegram failure - `could not run the agent: completion
exited with code 143: ... --mode json Yes ... --compact-before` - got four
layered defenses plus a git-guard hardening:

1. `src/gateway/completion-failure.ts` (new): classifies runner errors
   (interrupted/killed/timeout/session_busy/spawn/failed, transient flag) and
   renders one short user sentence per kind. Never leaks the command line.
2. `src/gateway/gateway.ts`: `runCompletionWithRetry` - transient failures
   retry once (default) after 5s with `compactBefore` dropped, streaming into
   the same bubble; non-transient/exhausted failures deliver the short
   message, raw detail goes to console.error. `requestRestart`/active-runs
   tracking defers the /update restart until in-flight runs settle (grace
   30s, then dropped with a log line). Fixed a double-fire race between the
   deferred loop and the run-settle path.
3. `src/gateway/transports/telegram.ts`: delivery dedup on (chat, text,
   msg.date) inside a window (default 10 min) - a replayed update is skipped
   before it can spawn a second run on the same session; still acked.
4. `src/gateway/completion.ts`: `compactTimeoutMs` (default 10 min) for
   compact-before runs; plain runs keep `timeoutMs` (5 min).
5. `src/cli/gateway-command.ts`: env knobs for all of the above
   (GATEWAY_COMPLETION_*, GATEWAY_COMPACT_*, GATEWAY_RESTART_GRACE_MS,
   GATEWAY_MESSAGE_DEDUP_MS).
6. `src/extensions/git-guard/guard.ts` (ADR-0049 follow-up): the global-option
   strip now covers quoted paths, `-c key=val`, `--work-tree`, `--no-pager`,
   `--bare` so those forms cannot bypass the destructive-git patterns.

Docs: `docs/adr/ADR-0051-gateway-completion-resilience.md`, CONTEXT.md
"Completion resilience" term, this handoff.

## What was verified

- 18 new tests red-first (failure classification, retry/drop-compaction,
  busy-session retry, non-transient no-retry, graceful no-leak messages,
  restart deferral incl. the double-fire race, telegram dedup incl. window
  expiry, compact timeout split, git-guard quoted/option forms).
- Targeted suites 179/179; full gateway dir 348/348.
- Full ./test.sh: 5104 passed / 14 failed - the 14 are EXACTLY the
  documented sandbox known-fails (daemon-serialized-refine x1, 4603 x4,
  4685 x9 EXDEV hard-link), no regressions.
- `npx biome check .` clean (2 pre-existing infos in telegram-transport.test.ts
  unchanged), `tsgo --noEmit` clean.

## Deploy state

- Merged to main and pushed; dist rebuilt; live gateway unit restarted to
  pick up the new source (see session summary).
- Live gateway runs the SOURCE via tsx from the shared tree; a unit restart
  picks up the merged code. Env knobs default to the safe values, no unit
  change required.

## Follow-ups (honest)

- Cross-process replays (two gateway instances) are only partially covered:
  the dedup log is in-memory; a file-backed log or ack-before-deliver would
  close it fully. The busy-session retry is the backstop.
- The exact SIGTERM sender at 16:38 was not identified with certainty
  (no unit stop, no OOM, no deploy, no daemon at that minute); the layers
  above cover every identified failure class regardless of the sender.
