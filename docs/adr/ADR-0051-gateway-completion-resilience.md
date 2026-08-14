# ADR-0051: Gateway completion resilience (retry, graceful failures, restart deferral, delivery dedup)

**Status:** accepted
**Date:** 2026-08-14
**Extends:** ADR-0001 (gateway), ADR-0004/#6 (streaming), ADR-0022 (delivery ledger), ADR-0034 (self-update), ADR-0039 (poll pause)
**Follows up:** ADR-0049 (git guard, global-option stripping)

## Context

On 2026-08-14 the Telegram gateway answered the operator's "Yes" with:

    could not run the agent: completion exited with code 143:
    .../dist/bundle/cli.js --mode json Yes --profile default
    --session-id gw-a149f075 --compact-before ...

Exit 143 is the completion child's own SIGTERM handler: something terminated
the child while a second, identical run for the same message carried on and
finished the work (the session shows one "Yes" and one completed turn).
Forensics found no unit restart at that minute (the next systemd stop was
16:40:58), no OOM kill, no deploy script, and no daemon process. The strongest
explanation is a duplicate delivery of the same Telegram update (two polls
racing on the same offset before confirmation, or a replay through a stale
persisted offset), which spawned a second completion on the same session; the
losing child was terminated and the gateway surfaced the raw error with the
full command line.

Whatever the exact terminator, four gaps are real and all four let a transient
hiccup reach the user as a raw, dead-end error:

1. Any nonzero child exit is surfaced verbatim - command line, exit code, and
   all - with no retry and no classification.
2. A duplicate inbound message is not recognized; the per-channel chain only
   serializes, it does not dedupe, so a replay spawns a second run on the same
   session (the session lease then rejects one of them).
3. A gateway restart (e.g. `/update now`, the deploy pattern) SIGTERMs every
   process in the unit's cgroup, including an in-flight completion.
4. Compaction (`--compact-before`) and the reply share one 5-minute timeout;
   a large session's compaction can eat the budget the reply needs.

## Decision

Four layered defenses in the gateway (`packages/coding-agent/src/gateway/`):

1. **Failure classification + retry.** New pure module `completion-failure.ts`:
   `classifyCompletionFailure` maps runner errors to kinds (interrupted=143,
   killed=137, timeout, session_busy, spawn, failed) with a transient flag;
   `describeCompletionFailure` returns one short user sentence per kind. The
   gateway runs every completion through `runCompletionWithRetry`: transient
   failures retry after `completionRetryDelayMs` (default 5s) up to
   `completionRetries` extra attempts (default 1). The retry drops
   `compactBefore` so the second attempt is as light as possible, and streams
   into the same bubble so the user sees one continuous reply. Non-transient
   failures and exhausted retries deliver `could not run the agent: <short
   sentence>` - never the command line; the raw error goes to the journal
   (console.error) for operators.
2. **Delivery dedup.** `TelegramTransport` remembers (chat, text, msg.date)
   triples for a window (`dedupWindowMs`, default 10 min): a re-delivered
   update is skipped before it can spawn a second run (the update is still
   acked via the offset). The Bot API date is second-precision, so two
   distinct human messages can never collide; only a true replay has the
   identical triple.
3. **Restart deferral.** The gateway tracks in-flight runs (`activeRuns`); the
   post-/update restart goes through `requestRestart`, which waits (polling,
   up to `restartGraceMs`, default 30s) for runs to settle and drops the
   restart if the grace expires - killing the gateway must never kill a reply
   in progress. The run-settle path fires a deferred restart exactly once.
4. **Split timeouts.** `CliCompletionRunner` gains `compactTimeoutMs` (default
   10 min) used when a run compacts first; the plain `timeoutMs` (default
   5 min) stays for everything else.

Env knobs (`gateway-command.ts`): `GATEWAY_COMPLETION_TIMEOUT_MS`,
`GATEWAY_COMPACT_TIMEOUT_MS`, `GATEWAY_COMPLETION_RETRIES`,
`GATEWAY_COMPLETION_RETRY_DELAY_MS`, `GATEWAY_RESTART_GRACE_MS`,
`GATEWAY_MESSAGE_DEDUP_MS`.

The same branch also hardens the git guard (ADR-0049 follow-up): the
global-option strip now covers quoted paths (`-C "/path with space"`),
`-c key=val`, `--work-tree`, `--no-pager`, and `--bare`, so those forms can no
longer slip past the destructive-git patterns.

## Consequences

- A transient child kill now costs one short retry delay and the user sees one
  continuous reply instead of a raw error; a duplicate delivery is dropped;
  an `/update now` restart no longer kills an in-flight run.
- The busy-session case still ends in a short message when the session stays
  held past the retry - the operator can `/new` or wait; the message is honest
  about why.
- Cross-process replays (two gateway instances polling the same offset) are
  only partially covered (the dedup log is in-memory); the session lease
  remains the backstop, and its error is now classified and retried.
