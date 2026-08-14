# Handoff: schedule tools (issue #32, ADR-0053)

Branch `feat/schedule-tools` (isolated worktree `.worktrees/issue-32-schedule-tools`,
cut from origin/main = a384f4ed9). Never touched the shared main tree.

## What was done

Model-facing reminders that return later as ordinary turns:

1. `packages/coding-agent/src/core/schedule/` (new):
   - `types.ts`: `ScheduleReminder` (id/kind/channelId/sessionId/text/dueAt/
     intervalMs?/projectRoot?/createdAt), a shape guard, and the env-tag
     constants `AXIOM_GATEWAY_CHANNEL_ID` / `AXIOM_GATEWAY_SESSION_ID`.
   - `parse.ts`: pure `parseDurationMs` ("30" = minutes, 30s/10m/2h/1d;
     positive-only, overflow-guarded, optional minimum) and `parseInstantMs`
     (strict ISO 8601 with an explicit zone; component round-trip rejects
     impossible calendar instants); `MIN_EVERY_INTERVAL_MS` = 5 minutes.
   - `store.ts`: append-only JSONL store at `<AXIOM_HOME>/gateway/schedule.jsonl`
     with `schedule`/`fire` line kinds; `foldSchedule` replays the log (later
     create wins, fire deletes, malformed lines skipped); mkdir -p on append.
   - `manager.ts`: `ScheduleManager` sweeps on start (immediate, so a reminder
     missed while down fires exactly once on boot) and on a poll (default 10s);
     fire records are appended BEFORE delivery, recurring reminders re-create
     at the earliest future slot (missed slots collapse to one turn), onDue
     errors are caught and logged, never thrown out of a sweep.
2. `packages/coding-agent/src/extensions/schedule/` (new): three TypeBox tools
   - `schedule_after` (positive delay), `schedule_at` (absolute instant, must
   be future), `schedule_every` (interval >= 5m) - each appends a reminder
   tagged with the run's channel/session (and projectRoot when anchored) and
   returns a confirmation or a plain error. Inert unless BOTH env tags are
   present (registered in `builtInExtensions` via a default export).
3. `packages/coding-agent/src/gateway/`:
   - `completion.ts`: `CliCompletionRunner` now tags every channel-tagged
     completion child with the two env vars (unanchored: merged child env;
     anchored: through `confinementEnv`). Untagged runs get explicit unset, so
     a stale tag in the gateway's own environment can never leak into a cron
     or helper child. `fakeCompletionRunner` records `channelId`.
   - `types.ts`: `CompletionRunner` inputs gain optional `channelId`.
   - `gateway.ts`: optional `deps.schedule`; the gateway owns a
     `ScheduleManager` whose onDue feeds `enqueueReminder`, which chains the
     reminder onto its channel's serialization chain; `runReminderTurn` runs
     the completion with the stored sessionId + text + projectRoot (tagged
     with the channel, so schedule tools work inside reminder turns) and
     delivers via the shared `runBatchTurn` (extracted from handle()'s batch
     path; identical error classification/retry). Interactive inputs now
     carry `channelId`. `sweepSchedule(now?)` is the test seam. Schedule
     starts after transport.connect and stops with the gateway.
   - `gateway-command.ts`: wires `schedule: { storePath: join(root, "gateway",
     "schedule.jsonl"), pollMs: envInt("GATEWAY_SCHEDULE_POLL_MS", 10000) }`.
4. Docs: `docs/adr/ADR-0053-schedule-tools.md`, CONTEXT.md "Schedule tools"
   term, this handoff.

Out of scope (per issue): reminders crossing sessions, operator-cron changes,
timezone conversion beyond UTC, delivery to other channels.

## What was verified

- 43 new tests, RED FIRST: the five new files were written and run before any
  implementation existed (all five failed on missing modules), then went green.
  - `test/core/schedule-parse.test.ts` (14): duration units/zeros/malformed/
    overflow/minimum; instant Z/offset/fractional/compact-offset, zone-less
    and impossible-calendar rejection.
  - `test/core/schedule-store.test.ts` (9): fold semantics (fire removes,
    duplicate create last-wins, recurring fire+recreate, malformed skipped,
    sort), round-trip across store instances, garbage-line tolerance, mkdir.
  - `test/core/schedule-manager.test.ts` (6): fires due once + future left
    alone, exact-due boundary, recurring earliest-future-slot reschedule,
    missed-while-down fires once on start, fire-before-delivery (crashing
    onDue never re-fires), inert before start / after stop.
  - `test/extensions/schedule.test.ts` (9): inert without tags / with one tag,
    env-tag reads, tool registration, after/at/every store writes with exact
    dueAt/intervalMs, rejections (zero/malformed delay, past/zone-less
    instant, <5m interval, empty/oversized text) store nothing.
  - `test/gateway/schedule-turn.test.ts` (4): due reminder runs as an ordinary
    turn (stored sessionId + text + channel tag) and delivers to the channel,
    recurring fires once then next slot, per-channel serialization with an
    interactive turn (manual-gated runner proves the reminder waits),
    missed-while-down fires exactly once on gateway start.
  - `test/gateway/completion.test.ts` (+1): the child env actually carries the
    two tags when channelId is passed, and a stale ambient tag is deleted for
    untagged runs (real spawned shim reads its own env).
- Floor: `./test.sh` from the worktree root (AXIOM_PROJECT_ROOT unset):
  5196 passed / 17 failed. The 17 = 14 documented sandbox known-fails
  (daemon-serialized-refine x1, 4603-worker-recovery x4, 4685-daemon-client-
  modes x9, EXDEV hard-link layout) + 3 real-kernel flakes
  (ipython-bootstrap, kernel-agent-observe-skill, kernel-attach-image-skill)
  that all pass standalone (6/6, 2/2, 9/9). No new failures.
- `npx biome check .`: clean (only the 2 pre-existing documented
  telegram-transport infos). `npx tsgo --noEmit` (packages/coding-agent):
  clean.

Method: unit + mock (fake runners/transports, temp-dir stores, injectable
clocks). NOT live-verified against the Telegram bot: no live gateway run was
started with the new code (operator-gated); the delivery path is covered by
the same mock-transport seam the other gateway suites use.

## Remaining

- Live smoke on the real gateway (restart the unit, ask for a 2-minute
  reminder, observe the turn arrive) - needs the operator.
- Follow-ups kept out of scope: reminders that survive a session reset
  (/new), session-zone timezone conversion, delivery to other channels.
