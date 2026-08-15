# Handoff — 2026-08-15 (build session: #60 cron recovery filter, built, merged, closed)

## What this session did

Closed the #58 residual: interrupted-dispatch recovery on scheduler start was
unfiltered, so a booting scheduler resolved any dangling dispatch in the
shared cron store (a gateway boot could mark a daemon once-job interrupted).
Built on `feat/cron-recovery-filter`, merged to main as `87d0eb624`, pushed,
and closed #60 with the audit comment. The branch is deleted.

1. **One predicate gates both mutation paths (962467a82).**
   `AgentCronScheduler.start()` passes its `claimFilter` hook into
   `recoverInterruptedDispatches(now, { recoveryFilter })`; no new hook, so
   the claim/recovery partition cannot drift. The store-level filter is
   backwards-compatible (default: recover-all). `recoverInterruptedInState`
   filters per dispatch by resolving its job in the same state;
   `recoverInterruptedDispatchesById` stays unfiltered (it only ever sees
   dispatches this scheduler just claimed). Orphan dispatches (job gone)
   pass any filter: resolving one only removes the record, so either owner
   may clean it.
2. **Red-first pins, both directions.** Gateway: a daemon-owned dangling
   heartbeat dispatch survives a gateway scheduler start untouched (still
   claimed, no lastError) and the daemon's own recovery resolves it. Daemon:
   a gateway cron job's dangling dispatch survives a daemon scheduler start
   untouched, and the gateway's own recovery resolves it. Core store:
   filtered recovery resolves only admitted dispatches; core scheduler:
   start recovers only its claim filter's jobs; orphan cleanup pinned.
3. **ADR-0086** records the recovery partition. ADR-0084's recorded residual
   is refreshed to point at it.

## Verified

- Red first: 4 failing pins on main, then green — cron-jobs.test.ts,
  gateway/cron.test.ts, daemon-mode.test.ts (261 tests).
- Full `./test.sh` floor green on the merged tree (exit 0); `npx biome check .`
  clean (4 pre-existing infos, none in touched files); `tsgo --noEmit` clean;
  pre-commit hook green on every commit.

## Tracker state (final)

- #60: CLOSED with the audit comment (merge 87d0eb624, ADR-0086, this
  handoff). No new follow-ups filed.
- #59 (dashboard, ADR-0085 reserved) remains the next needs-triage item per
  the ADR-0078 port order; its scope still needs owner settlement (grilling)
  before it can go ready-for-agent.
- #52 / #53 owner-blocked, untouched (worktree /tmp/axiom-worktrees/kernel-bridge stays).
- docs/hermes-improvements.html still untracked — not ours.
