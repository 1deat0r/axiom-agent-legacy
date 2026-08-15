# ADR-0084: Cron spine — /cron schedules, gateway runs, ledgered deliveries

**Status:** accepted
**Date:** 2026-08-15
**Issue:** #58 (ADR-0084 reservation)
**Implements:** ADR-0078 port order (cron, the step after gateway channels)
**Extends:** ADR-0001/0004/0006 (gateway architecture), ADR-0022 (delivery
ledger), ADR-0053 (schedule tools boundary), ADR-0058 (operator-gated live
verification), ADR-0083 (channels record)

## Context

The operator cron spine shipped before its record existed: `GatewayCron`
(packages/coding-agent/src/gateway/cron.ts) reuses the baseline
`AgentCronJobStore` + `AgentCronScheduler` at the profile's `cron-jobs.json`
to schedule agent runs and deliver each run's output to the channel that
created the job, with every scheduled-run delivery ledgered under the
delivering transport's name (ADR-0022). When the ADR-0078 spine issues were
cut, #58 reserved ADR-0084 for the record. The scoping note on #58 verified
the live surface against the wiring and found five gaps; the owner settled
the scope in a grilling session (both notes are the two latest comments on
the issue). This milestone closes the three build gaps and records the
capability.

## Decision

1. **What cron is.** The operator surface is `/cron add|list|rm` (gateway
   command, delivered to the creating channel only). The schedule grammar is
   the store's own (`parseAgentCronSchedule`): `every Ns|m|h` (recurring,
   10-second floor), `in Nm|h|d` (once), `at <ISO>` (once, must be future),
   `@hourly`/`@daily` (plus `@weekly`/`@monthly`) aliases, and a five-field
   cron expression (process-local timezone). `source: "cron"` jobs carry a
   `channelId`; a run boots the same headless completion seam as an
   interactive reply under a `cron-<channel>` session namespace (process
   isolation, ADR-0014) and `transport.send()`s the reply to the channel,
   recorded in the shared delivery ledger with the transport name.
2. **The claim race is fixed, as the pair.** Gateway and daemon schedulers
   point at the same `cron-jobs.json` on the default profile, and `claimDue`
   claimed every due job regardless of source — advancing `nextRunAt` before
   the run guard could reject the job. A gateway sweep therefore ate a due
   heartbeat (skipped, runCount 0, nextRunAt pushed forward) and a daemon
   sweep claimed a gateway `/cron` job as a channel-less daemon turn. The fix
   is a backwards-compatible optional claim filter threaded from the
   scheduler hooks through `store.claimDue` into `claimDueInState` (default:
   claim every due job). `GatewayCron` claims only `isGatewayCronJob` (new
   shared predicate: `source === "cron" && channelId !== undefined`); the
   daemon claims its complement. The existing runJob guard (no channelId or
   not cron-sourced => skipped) stays as the backstop. Red-first pins both
   directions: a due heartbeat survives a gateway sweep untouched (nextRunAt,
   runCount), and a gateway cron job survives a daemon sweep untouched.
3. **The daemon filter is the complement, not heartbeats-only.** The scoping
   premise "`source: "cron"` has exactly one creation site" missed the
   daemon's own `cron_add` (`axiom schedule add`, `createCronJobForState`),
   which also creates cron-sourced jobs — without a channel. A literal
   heartbeats-only daemon filter would strand those jobs (claimed by no one),
   so the daemon claims `!isGatewayCronJob(job)`: heartbeats, rlm heartbeats,
   and its own schedule jobs. The two filters still partition the shared
   store exactly; `axiom schedule` keeps working.
4. **`/cron list` and `/cron rm` see only gateway-owned jobs.** Both filter
   on `isGatewayCronJob`, so heartbeats and daemon schedule jobs sharing the
   store never render as cron jobs and can never be cancelled from the
   gateway. Heartbeats stay visible/cancellable only through
   `axiom daemon cron`.
5. **The spine has a live-verification home.** The ADR-0058 catalog gains a
   `cron-spine` check: a temp AXIOM_HOME, a stubbed completion (no model
   spend, no tokens), a forced `runDue` on the compiled binary, proving
   claim → run → deliver → ledger — and asserting a due heartbeat planted in
   the same store file survives the sweep untouched (the race this check
   would have caught). Gated only on the built gateway module, so it runs
   whenever the build exists. `docs/live-verification.md` gains the table
   row.
6. **Live vs deferred (recorded honestly).** Pause/resume is deferred: the
   store supports `paused` and `/cron list` renders the label, but no
   command can produce one. Fan-out via `deliverTo` (ADR-0022's "the
   automation spine can then feed" note) is a wanted follow-up, recorded not
   built — cron delivers to its creating channel only. The ADR-0053 boundary
   stands: model-facing schedule tools (`schedule_after/at/every`) are a
   separate surface (schedule.jsonl, same-session delivery, swept by the
   gateway's ScheduleManager), deliberately not the operator cron. The
   daemon's `axiom schedule` CLI remains its own operator surface on the
   shared store, owned by the daemon scheduler.
7. **Recorded mechanics** (verified in core/cron-jobs.ts): downtime catch-up
   coalesces to ONE run on boot (nextRunAt advances from claim time, not
   scheduled time); `once` jobs complete after their single run; paused jobs
   never fire; dispatch claims are durable and recovered on start; and
   per-session lanes serialize concurrent runs of one session's jobs.

## Consequences

- One record now says what the cron spine is, what is live, and what is
  deferred — the ADR-0082 pattern applied to the automation spine.
- The catalog is six checks: provider-chat, agent-run, rlm-kernel,
  gateway-delivery, slack-socket-mode, cron-spine. Skip-not-fail contract
  unchanged; the new check skips only when the build is absent.
- ADR-0022's known limitations are refreshed: the "spine delivering through
  `deliverTo` once the branch rebases onto the cron baseline" line was stale
  (the rebase happened and cron is live); fan-out via `deliverTo` remains the
  wanted follow-up.
- **Recorded residual:** interrupted-dispatch recovery on scheduler start is
  unfiltered, so a booting scheduler resolves any dangling dispatch in the
  shared store — a gateway boot can mark a daemon once-job interrupted. The
  claim filter closes the hot path; recovery filtering is a follow-up (the
  shared store file does not exist in production yet, so this is latent like
  the fixed race was).
- Verification: 14 cron tests were green at scoping (9 manager + 5 command);
  this milestone adds the claim-filter pins (gateway, core store/scheduler,
  daemon) and the command-filter pins, and grows the live-verification
  catalog suite. The full floor runs at the merge.
