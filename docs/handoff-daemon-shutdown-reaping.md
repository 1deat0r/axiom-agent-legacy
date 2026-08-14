# Handoff: last-resort worker reaping at daemon supervisor shutdown (issue #34)

## What was done

The machine OOM'd at 20:33 (31G RAM + full zram). Cleanup found 152 orphaned
`axiom` processes (13.5 GB RSS) parented to systemd, plus 16 stale
`/tmp/axiom-4685-*` socket dirs from the daemon client-modes suite. Code
reading proved the leak: `DaemonSupervisor.shutdown()` stops workers with
`stopWorker`, and when a worker survives the stop attempt the background
finalizer (`finalizeTimedOutWorkerStop`) was gated on `!this.shuttingDown` -
so during shutdown it could never escalate, and `shutdown()` exited leaving
the wedged worker alive forever.

Fix (ADR-0056): in the `WorkerStopTimeoutError` catch, `shutdown()` now does
one fresh identity check and force-kills before exit. Current identity
signals the process group via `signalProcessGroupOrProcess`; unknown identity
gets a group-only SIGKILL (no single-pid fallback, so a recycled pid cannot
be signaled); replaced or gone identities are never signaled.
`WorkerStopTimeoutError` is now exported for tests.

## What was verified

- Red-first: 4 new tests in `test/daemon-supervisor-shutdown.test.ts` (real
  detached `sleep` processes; real identity reads) failed before the fix,
  pass after.
- One existing monitor test encoded the old leaky behavior and was updated
  to the new contract (`group-kills an unverifiable-identity worker at
  shutdown without awaiting its finalizer`).
- Targeted suites: daemon-supervisor-shutdown, daemon-supervisor-monitor,
  daemon-supervisor-eviction = 91/91 green on branch and merged main.
- Full floor on the branch (test.sh, scrubbed env): agent 77, ai 315,
  coding-agent 5253 passed / 14 failed = ONLY the documented sandbox
  known-fails (daemon-serialized-refine 1, 4603 x4, 4685 x9), tui 761.
  No regressions.
- biome clean on touched files; tsgo --noEmit exit 0 on branch and merged
  main.
- dist rebuilt on merged main so CLI-spawned daemons run the fix.

## How

Unit tests (real processes, mocked stop path) - no live-agent runs. The
kill-path behavior is deterministic: it is a decision in the shutdown catch,
not a timing race.

## Notes

- The leaked workers were killed manually before the fix: 319 processes
  (160 orphans + descendants), ~18 GB freed. The gateway, hermes, signal-cli,
  and this session were verified alive afterward.
- The user's three terminal TUI windows were closed around the same time;
  their sessions (019ffea6, 019ffea7, 019ffed3) remain resumable on disk.
- The daemon supervisor for /tmp/axiom-1000/daemon.sock was among the killed
  orphans; the next daemon-needing operation spawns a fresh supervisor from
  the rebuilt dist.
- Merge: 05d903754 (main), feature 2860c9fce. Issue #34.
