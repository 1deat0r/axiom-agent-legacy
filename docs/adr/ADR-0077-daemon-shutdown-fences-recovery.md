# ADR-0077: Daemon shutdown fences in-flight worker recovery — re-admission is gated on shuttingDown and awaited before the workers snapshot

**Status:** accepted
**Date:** 2026-08-15
**Investigated by:** agent session (issue #53)
**Evidence:** deterministic in-process repro (committed red tests), the full
daemon supervisor unit family, the serialized process-stress phase, and the
4603 shutdown regression (about 1 in 4 full floors before this change, per
ADR-0075).

## Context

Issue #53 charged the daemon supervisor with leaving services that reappear
after `daemon shutdown --force`: the 4603 shutdown regression intermittently
sees three service records in `status --json` within 11s of a shutdown whose
process-exit checks verified clean. The 4603 suite asserts wall-clock process
lifecycles, so it runs serialized in the process-stress phase (ADR-0075);
that containment is interim, not the fix.

## Findings (what the race is)

Worker re-admission — the spawn, the descriptor persist, and the
`workers` re-registration in `launchWorker` — is gated only by
`assertRecoveryAllowed()`, which checks the registry-file shutdown admission
and ownership, but **not** the supervisor's own `shuttingDown` state. Two
windows follow from that:

1. **Admission-release tail.** The CLI holds the shutdown admission until its
   listener-silence convergence, then releases it. The supervisor's process
   exit happens later — after catalog stop, socket cleanup, and lease and
   ownership release. During that tail, `shuttingDown` is already true but the
   admission file is gone, so a checkpointed or deferred recovery re-passes
   the gate, spawns a detached worker, re-persists its descriptor, and the
   supervisor exits leaving ghosts that `status --json` then reports.
2. **Snapshot race.** `shutdown()` snapshots `this.workers` for stopping but
   never awaits in-flight `worker.recovery`, `worker.deferredRecovery`, or
   `openingWorkers` promises. Work that passed its last checkpoint can
   re-persist a descriptor and re-register a worker after `stopWorker` deleted
   it, or after the snapshot, and the spawned child is detached so it
   survives the supervisor exit.

The deferred-recovery loop itself already exits once `shuttingDown` is set
(its candidate check reads it); it was the admission-file-only gate and the
missing await that left the holes.

## Decision

1. `assertRecoveryAllowed()` throws `SupervisorRecoveryCancelledError` when
   `this.shuttingDown` is set. This is the invariant: a shutting-down
   supervisor never re-admits workers. It closes every checkpoint window at
   once — the recovery retry loop, `launchWorker`, `connectWorker`, the
   deferred-recovery resume, and startup adoption (unaffected: startup never
   runs with `shuttingDown`).
2. `shutdown()` awaits all in-flight `worker.recovery`,
   `worker.deferredRecovery`, and `openingWorkers` promises before the
   workers snapshot. `shuttingDown` is set first, so each pending piece of
   work either completes (and lands in the snapshot, where `stopWorker`
   reclaims it) or self-cancels at its next checkpoint. The wait is bounded:
   every await inside the recovery paths either throws on the gate or is
   deadline-limited.
3. Two monitor-test harnesses that drive `shutdown()` on prototype partials
   gain an `openingWorkers` map to match the new fence.

## Consequences

- The deterministic repro lives in
  `test/daemon-supervisor-recovery-shutdown.test.ts`: the gate rejects on a
  shutting-down supervisor with no admission record, and shutdown does not
  stop workers until in-flight recovery and deferred recovery settle.
- The 4603 suite remains tagged `process-stress`: its assertions are
  wall-clock process lifecycles, which stay load-sensitive; the tag is no
  longer hiding a product defect, matching ADR-0076's reasoning for
  `kernel-heavy`.
- `daemon shutdown --force` can no longer leave behind workers, descriptors,
  or listeners spawned by the recovery machinery after the shutdown
  admission converges.
