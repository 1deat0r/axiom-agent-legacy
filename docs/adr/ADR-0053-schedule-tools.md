# ADR-0053: Schedule tools (schedule_after, schedule_at, schedule_every return as ordinary turns)

**Status:** accepted
**Date:** 2026-08-14
**Extends:** ADR-0001 (gateway), ADR-0014 (profiles/anchoring), ADR-0039 (poll pause), ADR-0050 (completion resilience)
**Follows up:** ADR-0051 (gateway completion resilience)

## Context

A Telegram assistant's most useful feature is "remind me": the user asks, the
agent answers, and at some later time the reminder arrives and the agent reacts
to it. Axiom has no model-facing way to do this today. The operator-facing
gateway cron (`/cron`, `packages/coding-agent/src/gateway/cron.ts`) schedules
operator-defined runs with their own `cron-<channel>` session namespace; it is
not a model tool and must not be overloaded into one.

The deepseek-harness research has a schedule domain - after, at, and every
reminders that return as ordinary later conversation turns. The requirement
here is the same: the reminder must come back as if the user had typed it, into
the same session, delivered to the same channel, surviving a gateway restart,
and a reminder that missed its time while the gateway was down must fire once
(not repeatedly, not a backlog burst).

## Decision

Three model-facing tools plus a gateway-side delivery loop, kept strictly
separate from the operator cron.

### The tools (agent side)

`packages/coding-agent/src/extensions/schedule/` registers three tools that
are inert unless the gateway tagged the run: `AXIOM_GATEWAY_CHANNEL_ID` and
`AXIOM_GATEWAY_SESSION_ID` are set on every completion child the gateway
spawns (interactive and reminder turns), so the tools exist only where a
delivery path exists - interactive CLI runs and untagged children get no
schedule tools.

- `schedule_after { delay, text }`: a positive delay. Bare numbers are
  minutes; `30s`/`10m`/`2h`/`1d` suffixes are accepted. Due = now + delay.
- `schedule_at { instant, text }`: an absolute ISO 8601 instant with an
  explicit zone (`Z` or a numeric offset). Zone-less local times are rejected
  (ambiguous across the gateway and the run); the instant must be in the
  future; impossible calendar instants (e.g. Feb 30) are rejected by
  component round-trip, never silently rolled over.
- `schedule_every { interval, text }`: a fixed interval of at least five
  minutes (`MIN_EVERY_INTERVAL_MS = 300000`). Due = now + interval, then due
  advances by the interval on each fire.

Each tool appends one reminder record - `{ id, kind, channelId, sessionId,
text, dueAt, intervalMs?, projectRoot?, createdAt }` - to an append-only JSONL
store at `<AXIOM_HOME>/gateway/schedule.jsonl` and replies to the model with a
confirmation (or a plain error for bad input, which the model can relay). The
store path is shared with the gateway: for the default profile the child's
axiom home IS the gateway's, and for anchored runs the axiom home is
bind-mounted writable into the bubblewrap sandbox, so both sides read and
write the same file. Reminder text is capped at 4000 characters.

### The store (shared)

`packages/coding-agent/src/core/schedule/store.ts`: append-only JSONL, because
the agent and the gateway are different processes and append is atomic for
small lines - there is no read-modify-write race to lose an update. Two line
kinds: `{ type: "schedule", reminder }` and `{ type: "fire", id, firedAt }`.
`foldSchedule` replays the log into the active set (later create wins, fire
deletes; malformed lines are skipped), so the effective state is always
derivable from the file - persistence across restarts is just reading the
file again.

### The delivery loop (gateway side)

`packages/coding-agent/src/core/schedule/manager.ts` (`ScheduleManager`)
sweeps the store on start (immediately, so a reminder missed while the
gateway was down fires exactly once on the next boot) and then on a fixed
poll (`GATEWAY_SCHEDULE_POLL_MS`, default 10s). One sweep:

1. Fold the store, take reminders with `dueAt <= now`.
2. Append each one's fire record FIRST - a crash mid-delivery can never
   re-fire the same slot.
3. For recurring reminders, re-create the same id at the earliest future slot
   (`dueAt += interval` until past now), so a long downtime collapses missed
   occurrences into one turn instead of a burst.
4. Hand each due reminder to the gateway's `enqueueReminder`.

`Gateway.enqueueReminder` chains the reminder onto its channel's existing
serialization chain (the same one interactive messages use), so a reminder
turn never interleaves with an in-flight interactive run on that channel. The
turn runs the completion with the reminder's stored `sessionId`, the reminder
text as the prompt, and the stored `projectRoot` (anchored reminders resume
anchored) - the reminder IS an ordinary user turn in its session. The reply
is delivered to the stored channel over the active transport with the typing
indicator and poll pause, exactly like a batch interactive reply (shared
`runBatchTurn`), and the turn is itself tagged with the channel so a schedule
tool inside a reminder turn can schedule again. Completion failures classify
and retry like any other turn (ADR-0050).

### Explicit non-goals (issue #32 scope)

Reminders that cross sessions (the reminder pins the session id it was
created in; a `/new` archive after scheduling means the turn resumes by that
id, not the archived file), changes to the operator-facing cron, timezone
conversion beyond UTC with the session's zone (instants are absolute UTC), and
delivery to any channel other than the session's own channel.

## Consequences

- The agent can now honor "remind me in 30m", "remind me at 20:30 UTC", and
  "remind me every 10m" for real: the reminder returns as a message turn and
  the agent replies at that time, across gateway restarts.
- The schedule store is a small append-only log; a malicious or buggy agent
  can append junk lines, which the fold skips - reads are never broken by bad
  lines.
- One sweep's onDue callbacks are fire-and-forget on the channel chains; a
  reminder turn competes for its channel exactly like a user message, and two
  reminders on the same channel are serialized (never two concurrent
  completions on one session).
- Delivery failure (transport down) still consumes the reminder: the fire
  record is already written. A lost delivery shows up in the ledger as ok:false
  like any other outbound failure, and recurring reminders continue at the
  next slot.
- The tools are absent outside gateway-tagged runs, so nothing promises a
  reminder it cannot deliver.
