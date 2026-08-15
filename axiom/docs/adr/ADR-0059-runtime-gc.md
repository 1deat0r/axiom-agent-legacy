# ADR-0059 — Garbage collection for the persistent Python runtime

## Status
Accepted (2026-08-14)

## Context
The axiom-runtime kernel is persistent: every cell's objects stay alive in the
IPython process until the cyclic GC frees them, and long-lived RLM sessions
grow without bound. The kernel also has no visibility into how much garbage
is accumulating: there is no pressure metric, no way to force a pass from the
host, and no turn-level record of a pass happening. Snapshot/restore caps the
*serialized* namespace (ADR-0041's session budget bounds the *gateway*
session), but nothing bounds live in-process memory.

## Decision
Garbage collection gets three layers, with the runtime module
`axiom-runtime/src/rlm/gc.py` as the single source of truth:

1. **Pressure measurement** (`measure_pressure`, `collect`):
   - Cheap path (the default): the stdlib GC's per-generation counters
     (`gc.get_count()`), collection totals (`gc.get_stats()`), and the
     uncollectable count. Microseconds, safe to run after every cell.
   - Detailed path: a full tracked-object scan (count + estimated bytes via
     `sys.getsizeof`, per-object failures tolerated) plus the user-namespace
     reachable closure (`gc.get_referents` BFS from the IPython `user_ns`
     roots, modules treated as leaves, id-dedup, node-capped). This is the
     "per namespace" tracking: user-reachable objects vs kernel-wide totals.
   - `collect()` runs a full cyclic pass and reports before/after detailed
     pressure plus `gc.collect()`'s found-unreachable count, so a caller can
     see what a pass actually freed.

2. **Threshold-based automatic passes** (`install_post_execute_gc`): the
   rlm bootstrap cell installs an IPython `post_execute` hook (idempotent,
   never raises, safe outside a kernel) with two triggers, in order:

   - Cheap, every cell: the sum of the stdlib generation counters
     (`gc.get_count()`) against `AXIOM_GC_MAX_UNCOLLECTED_OBJECTS`
     (default 2 000). With automatic collections enabled, CPython 3.11 caps
     this sum near 720 (thresholds 700/10/10) and it peaks near 2000 only
     under extreme churn, so this trigger is a burst tripwire, not a session
     bound. Operators can lower the env var for aggressive firing.
   - Periodic, every `DEFAULT_TRACKED_CHECK_INTERVAL` (32) post-execute
     invocations: the tracked-object count (`len(gc.get_objects())`) against
     `AXIOM_GC_MAX_TRACKED_OBJECTS` (default 250 000). The count grows with
     accumulated live and cyclic garbage and is the reachable default
     trigger. It fires on every periodic check while the count exceeds the
     threshold — a persistent bound, not a one-shot; no anti-thrash floor is
     kept, so a slow leak can never hide below a baseline.

   `AXIOM_GC_MAX_ESTIMATED_BYTES` (default 1 GiB) is report-only and never
   triggers a pass (a sizeof sum over every tracked object costs too much to
   run periodically). `gc_status()` reports thresholds, the check interval,
   hook state, and the last few automatic passes for observability.

   The shipped defaults (uncollected 2 000, tracked 250 000) are reachable;
   the original defaults (100 000 / 1 000 000) were not — the uncollected
   metric is structurally capped, which a review experiment proved and this
   ADR records (see Consequences).

3. **Host-side surface** (`kernel-gc.ts` + `KernelManager`): explicit
   `gcPressure(detailed?)` and `collectGarbage()` calls via synthetic
   internal cells (same marker-line pattern as state-snapshot), and an
   opt-in per-N-cell metadata check (`KernelGcOptions.checkEveryNCells`,
   default off; env `AXIOM_GC_CHECK_EVERY_N_CELLS`). When enabled, every Nth
   successful user cell's `ExecuteResult` gains `gc: {pressure, collect?}` —
   the turn metadata that makes memory pressure visible — and a collect runs
   when pressure crosses either trigger (the same metrics and defaults as
   the in-kernel hook; `KernelGcOptions.maxUncollectedObjects` /
   `maxTrackedObjects` override them). The check runs after the
   execution-queue slot is released so its synthetic cells cannot
   self-deadlock. `IpythonToolDetails.gc` carries the same data into session
   tool-call details. Programmatic options are sanitized like env values
   (a non-integer `checkEveryNCells` disables the check).

The bootstrap ready check (`RUNTIME_READY_CHECK`) asserts the new `rlm.gc`
surface so a stale venv or `AXIOM_KERNEL_PYTHON` fails fast with a clear
message instead of silently lacking GC.

## Consequences
- Long-lived sessions are bounded by default: the in-kernel hook collects
  when the periodic tracked-object count crosses 250 000 (reachable by
  leaks; a freshly booted kernel holds tens of thousands) and on the cheap
  per-cell counter at 2 000. Explicit host requests and the opt-in per-N
  metadata check remain available on top.
- Overhead is amortized: the cheap check costs microseconds per cell; the
  tracked check costs one `gc.get_objects()` list build every 32
  post-execute invocations. A session that stays above the tracked threshold
  pays one full collect pass per interval (bounded — tens of ms at ~250k
  objects, ~1-2 ms per cell amortized).
- Metric ceilings (measured, not assumed): with automatic collections on,
  `sum(gc.get_count())` is structurally capped near 720 (CPython 3.11
  thresholds 700/10/10) and peaks near 2 000 only under extreme churn — the
  original 100 000 default was unreachable and therefore inert. The tracked
  count is monotonic in live plus cyclic garbage and is the real pressure
  trigger.
- `estimated_bytes` is `sys.getsizeof`-based, so it undercounts objects that
  own memory outside their own allocation (bytearrays, numpy arrays) and
  those types are not GC-tracked either — `trackedObjects`/`userObjects`
  count only cyclic-GC-tracked objects. The pressure contract is the counts,
  not exact RSS.
- The per-N-cell host metadata check stays off by default (cell execution,
  snapshot, and restore paths are untouched without it); the in-kernel
  automatic pass is on by default because the bootstrap always installs the
  hook, and its thresholds are env-tunable.
- Known pre-existing flake (unrelated, documented not fixed): the forkserver
  path has an intermittent first-execute hang in fresh forked kernels
  (reproduced against the existing `kernel-state-roundtrip` suite on main's
  venv). The new kernel tests pin `AXIOM_KERNEL_FORKSERVER=0` like
  `ipython-provisioner.test.ts` already does; the forkserver itself stays
  covered by `kernel-fork-server.test.ts`.
