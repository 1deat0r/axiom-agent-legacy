# ADR-0056: Last-resort worker reaping at daemon supervisor shutdown

**Status:** accepted
**Date:** 2026-08-14
**Extends:** ADR-0029 (delegate tool), ADR-0046 (profile editing)

## Context

2026-08-14: the machine hit an OOM wall (31G RAM fully used, 31G zram swap
full). Cleanup found 152 leaked `axiom` processes (13.5 GB RSS) parented to
systemd, plus 16 leftover `/tmp/axiom-4685-*` socket directories from the
daemon client-modes regression suite. The leaked processes were detached daemon
session workers that outlived every supervisor that could stop them.

Code reading proves the leak chain:

1. Workers are spawned `detached: true` (own process group, reparented to
   systemd immediately).
2. `DaemonSupervisor.shutdown()` calls `stopWorker(worker, true, forceWorkers,
   true)`. When a worker ignores the graceful request and survives the
   deadline, `stopWorker` throws `WorkerStopTimeoutError`.
3. The background escalation (`finalizeTimedOutWorkerStop`) is gated on
   `while (!this.shuttingDown)`. `shutdown()` sets `shuttingDown = true`
   before stopping workers, so the finalizer can never iterate during
   shutdown - its SIGKILL escalation is dead code in exactly the scenario it
   exists for.
4. `shutdown()` catches `WorkerStopTimeoutError`, logs "remains tombstoned
   for recovery", and calls `process.exit()`. The worker lives forever: no
   supervisor, no owner watch (daemon workers are spawned without an IPC
   channel), no reaper. The shutdown admission stops the worker's self-heal
   supervisor relaunch, so it sits idle forever.

The stop path's identity gate also refuses to signal when the worker's
process start-id is unknown. That caution is correct during normal operation
(a recycled pid must never be signaled) but wrong at final shutdown, where the
choice is between a tiny unknown-identity risk and a guaranteed leak.

## Decision

`DaemonSupervisor.shutdown()` gains a last-resort reaping step in the
`WorkerStopTimeoutError` catch: one fresh identity check, then:

- `current` - the pid is provably our worker. Signal the process group via
  `signalProcessGroupOrProcess` (group first, single-pid fallback is safe for
  a verified identity).
- `unknown` - final shutdown favors leak prevention. Group-only SIGKILL
  (`process.kill(-pid, "SIGKILL")` with no single-pid fallback), so a recycled
  pid can never be signaled.
- `replaced` or `gone` - never signal; log the tombstone as before.

The background finalizer (`finalizeTimedOutWorkerStop`) is unchanged: its
conservative escalation stays correct for stops during normal operation, when
the supervisor remains alive.

`WorkerStopTimeoutError` becomes an exported class so tests can throw the
exact error the shutdown path catches.

## Consequences

- Wedged workers can no longer outlive a supervisor shutdown: the supervisor
  either stops them or kills them before it exits.
- The unknown-identity group-kill is a deliberate trade: it can only signal a
  process group whose leader pid matches the recorded worker pid. A recycled
  pid is not a group leader of that group, so the kill lands on an empty
  group and is a no-op.
- Normal-operation stop behavior is untouched; no new timers or background
  loops are added to the shutdown path.
