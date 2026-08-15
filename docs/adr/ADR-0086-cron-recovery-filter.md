# ADR-0086: Cron recovery filter — a booting scheduler resolves only its own dispatches

**Status:** accepted
**Date:** 2026-08-15
**Issue:** #60 (ADR-0086 reservation)
**Extends:** ADR-0084 (cron spine)

## Context

ADR-0084 fixed the claim race on the shared cron store but recorded a
residual of the same class: `AgentCronScheduler.start()` calls
`store.recoverInterruptedDispatches()` with no filter, so a booting scheduler
resolves every dangling dispatch in the shared `cron-jobs.json` — a gateway
boot can mark a daemon once-job interrupted (completed with lastError) and
vice versa. Latent like the fixed claim race (the shared store file does not
exist in production yet), but the partition argument that justified the claim
filter applies verbatim to recovery: the two schedulers agree the store is
partitioned, and recovery is a mutation of the other owner's records. #60 was
filed with the residual; the scope was settled by the #58 audit and ADR-0086
reserved at scope time per ADR-0071.

## Decision

1. **The claim predicate gates recovery too.** `AgentCronScheduler.start()`
   passes its `claimFilter` hook as the recovery filter into
   `recoverInterruptedDispatches`. One predicate gates both claim and
   recovery, so the partition cannot drift between the two mutation paths;
   no new hook surface is added.
2. **Backwards-compatible store filter.** `recoverInterruptedDispatches`
   gains an optional `{ recoveryFilter }` options argument. With no filter
   (the default), recovery behaves exactly as before: every dangling
   dispatch is resolved. The filter is applied per dispatch by resolving its
   job in the same state.
3. **Orphan dispatches are cleaned by either owner.** A dispatch whose jobId
   matches no job in the state passes any filter: resolving it only removes
   the dispatch record and cannot mark the other owner's job interrupted, so
   a strict skip would leak it in the shared file forever.
4. **The by-id recovery stays unfiltered.** `recoverInterruptedDispatchesById`
   is only called with dispatches this scheduler just claimed (the runDue
   catch path), so ownership already holds there; the filter applies only to
   the start-time sweep.
5. **Red-first pins, both directions.** (a) Gateway start leaves a
   daemon-owned dangling dispatch untouched — still claimed, no `lastError` —
   and the daemon's own recovery still resolves it. (b) Daemon scheduler
   start leaves a gateway cron job's dangling dispatch untouched, and the
   gateway's own recovery still resolves it. (c) Core store: a filtered
   recovery resolves only the dispatches it admits; a scheduler with a claim
   filter recovers only its own on start. (d) Core store: filtered recovery
   still cleans an orphan dispatch.

## Consequences

- The shared-store partition invariant now holds on both mutation paths
  (claim and recovery) under a single predicate per scheduler.
- ADR-0084's recorded residual is closed by this ADR (its consequences are
  refreshed to point here).
- Schedulers without a claim filter are unchanged (recover-all), as are the
  migration paths and the by-id recovery: baseline and worker behavior do not
  move.
- Verification: four new pins across gateway/cron.test.ts, daemon-mode.test.ts,
  and cron-jobs.test.ts (core store + scheduler); targeted suites green, full
  floor at the merge.
