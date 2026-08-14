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
   never raises, safe outside a kernel) that runs a full collect whenever
   uncollected objects cross `AXIOM_GC_MAX_UNCOLLECTED_OBJECTS` (default
   100 000). Thresholds are env-configurable:
   `AXIOM_GC_MAX_UNCOLLECTED_OBJECTS`, `AXIOM_GC_MAX_TRACKED_OBJECTS`
   (default 1 000 000), `AXIOM_GC_MAX_ESTIMATED_BYTES` (default 1 GiB).
   `gc_status()` reports thresholds, hook state, and the last few automatic
   passes for observability.

3. **Host-side surface** (`kernel-gc.ts` + `KernelManager`): explicit
   `gcPressure(detailed?)` and `collectGarbage()` calls via synthetic
   internal cells (same marker-line pattern as state-snapshot), and an
   opt-in per-N-cell metadata check (`KernelGcOptions.checkEveryNCells`,
   default off; env `AXIOM_GC_CHECK_EVERY_N_CELLS`). When enabled, every Nth
   successful user cell's `ExecuteResult` gains `gc: {pressure, collect?}` —
   the turn metadata that makes memory pressure visible — and a collect runs
   when the cheap pressure crosses the threshold. The check runs after the
   execution-queue slot is released so its synthetic cells cannot
   self-deadlock. `IpythonToolDetails.gc` carries the same data into session
   tool-call details.

The bootstrap ready check (`RUNTIME_READY_CHECK`) asserts the new `rlm.gc`
surface so a stale venv or `AXIOM_KERNEL_PYTHON` fails fast with a clear
message instead of silently lacking GC.

## Consequences
- Long-lived sessions stop growing without bound: garbage is collected on
  pressure thresholds in-kernel, on explicit host request, and (opt-in) with
  per-turn visibility.
- The default cheap measurement costs microseconds per cell (post-execute
  hook); detailed scans are explicit-only and cost a full object walk, which
  is why the per-N-cell check defaults to off.
- `estimated_bytes` is `sys.getsizeof`-based, so it undercounts objects that
  own memory outside their own allocation (bytearrays, numpy arrays) and
  those types are not GC-tracked either — `trackedObjects`/`userObjects`
  count only cyclic-GC-tracked objects. The pressure contract is the counts,
  not exact RSS.
- No behavior change by default: cell execution, snapshot, and restore paths
  are untouched; only an explicit opt-in or env var turns the metadata check
  on.
- Known pre-existing flake (unrelated, documented not fixed): the forkserver
  path has an intermittent first-execute hang in fresh forked kernels
  (reproduced against the existing `kernel-state-roundtrip` suite on main's
  venv). The new kernel tests pin `AXIOM_KERNEL_FORKSERVER=0` like
  `ipython-provisioner.test.ts` already does; the forkserver itself stays
  covered by `kernel-fork-server.test.ts`.
