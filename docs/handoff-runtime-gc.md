# Handoff — runtime GC (issue #37, ADR-0059)

## What was done
Added real garbage collection to the persistent Python runtime, in three
layers (details in ADR-0059). This revision fixes the review blocker: the
original default thresholds were unreachable (the cheap metric is
structurally capped near 720), so the default automatic pass is now driven
by a periodic tracked-object count with a reachable default.

1. **Runtime module `axiom-runtime/src/rlm/gc.py`**
   - `measure_pressure(detailed=False)`: cheap per-generation counters by
     default; `detailed=True` adds tracked-object count, estimated bytes
     (getsizeof sum, failures tolerated), and the user-namespace reachable
     closure (BFS from `user_ns` roots, modules as leaves, id-dedup, capped).
   - `collect()`: full cyclic pass reporting before/after pressure +
     found-unreachable count.
   - `install_post_execute_gc()`: idempotent post-execute hook with two
     triggers. Cheap per-cell check of `sum(gc.get_count())` against
     `AXIOM_GC_MAX_UNCOLLECTED_OBJECTS` (default 2 000 — a burst tripwire;
     the metric is capped near 720 with automatic GC on and peaks near 2000
     only under extreme churn). Periodic tracked-object check every 32
     post-execute invocations (`DEFAULT_TRACKED_CHECK_INTERVAL`, one
     `gc.get_objects()` list build) against `AXIOM_GC_MAX_TRACKED_OBJECTS`
     (default 250 000) — the reachable default trigger. It re-fires every
     interval while above the threshold (no anti-thrash floor: a slow leak
     can never hide). Never raises; safe outside a kernel.
   - `resolve_thresholds()` / `gc_status()`: env-tunable thresholds
     (also `AXIOM_GC_MAX_ESTIMATED_BYTES` 1 GiB, report-only — never a
     trigger) + observability (hook state, check interval, last 8
     auto-collects with reason and tracked count).
   - `rlm/__init__.py` exports `gc` lazily (importlib, not package-relative,
     to avoid `__getattr__` recursion).

2. **Host surface `kernel-gc.ts` + `KernelManager`**
   - `gcPressure(detailed?)` / `collectGarbage()`: synthetic internal cells
     with marker-line parsing (same pattern as state-snapshot).
   - Opt-in per-N-cell check (`KernelGcOptions.checkEveryNCells`, env
     `AXIOM_GC_CHECK_EVERY_N_CELLS`): every Nth successful user cell gets
     `result.gc = {pressure, collect?}`; a collect runs when pressure
     crosses either trigger (tracked count read per check, same defaults as
     the runtime; `maxUncollectedObjects` / `maxTrackedObjects` override).
     The check runs after the execution-queue slot is released so its
     synthetic cells cannot self-deadlock. Programmatic options are
     sanitized (invalid `checkEveryNCells` disables the check).
   - `IpythonToolDetails.gc` carries the metadata into session tool-call
     details (turn metadata). `IpythonToolOptions.gc` plumbs the option.
   - `RUNTIME_READY_CHECK` now asserts the `rlm.gc` surface so stale venvs /
     `AXIOM_KERNEL_PYTHON` fail fast with a clear message.

3. **Bootstrap wiring**: `RLM_BOOTSTRAP_BASE_CODE` installs the
   post-execute GC hook per kernel (wrapped in try/except, never breaks
   bootstrap).

## Verification (unit / mock / live — labeled)
- **Unit (Python)**: `axiom-runtime/test/test_gc.py`, 22 tests, all green
  under plain python3 (no IPython needed). New vs the original 18:
  default-fires (a bounded 400k-object cyclic burst held past the default
  250k tracked threshold trips the periodic check on the 32nd invocation,
  reason `tracked-threshold`; red-first, failed on the pre-fix code which
  never fired), cadence + re-fire (check runs on the interval's invocation
  and fires again while above threshold), tracked-check never-raises,
  module-alias dedup. Existing coverage unchanged: pressure shape
  (cheap/tracked/detailed), collect frees unreachable garbage, closure
  counting, threshold env parsing, hook idempotence/skip/never-raise/log
  bound.
- **Unit (TS)**: `test/kernel-gc.test.ts` pure tests, 19 green (was 12):
  cell builders, marker parsing, `resolveGcOptionsFromEnv` (off by default,
  both threshold overrides, invalid values), `crossesCollectThreshold`
  (below defaults false; tracked count past default fires even with the
  cheap counter at its 620 cap; cheap-counter threshold; missing tracked
  count), `sanitizeGcOptions` (valid kept; invalid checkEveryNCells drops
  the check; non-finite thresholds dropped).
- **Live (real kernel)**: same file, 5 kernel-heavy tests green against a
  scratch venv (`/tmp/axiom-gc-fix-venv`, built from the worktree runtime
  with the new gc.py): leak scenario (unchanged), per-N metadata attach
  below threshold, auto-collect at threshold 0, NEW default-fires (a
  300k-list burst held in the namespace + N=1 makes the next user cell's
  check run a collect with DEFAULT thresholds — trackedObjects asserted
  above 250k), off-by-default no-regression. The tests pin
  `AXIOM_KERNEL_FORKSERVER=0` (repo convention, see ipython-provisioner).
- **Kernel regression**: the 8 non-heavy kernel suites the change touches
  (kernel-gc, kernel-state-snapshot, kernel-bootstrap, ipython-provisioner,
  ipython-bootstrap, kernel-abort, kernel-startup, ipython-attachments):
  84 passed. `npx biome check` clean and `npx tsgo --noEmit` clean on all
  changed files. The full `./test.sh` floor was not re-run for this fix
  (the pre-fix floor on this tree was recorded by the original child).

## Not done / follow-ups (honest)
- `estimated_bytes` uses `sys.getsizeof`, so it undercounts objects owning
  memory outside their allocation (bytearrays, numpy arrays); those types are
  also not GC-tracked, so counts don't see them. The contract is counts, not
  RSS. A tracemalloc-based sampler is a possible follow-up.
- The per-N-cell metadata check is off by default; enabling it on the live
  gateway is an operator knob (`AXIOM_GC_CHECK_EVERY_N_CELLS`), not yet set.
- A session that legitimately holds more than 250k tracked objects pays one
  full collect pass per 32 cells (the trigger re-fires while above the
  threshold). Accepted trade-off for not keeping anti-thrash state; the
  cost is bounded and documented in ADR-0059.
- Review nit 4 (closure walk can extend `pending` once before the node cap)
  and nit 5 (no in-kernel E2E of the hook install) remain open; nits 1-3
  (module-alias dedup, bootstrap internal flag, programmatic option
  validation) are fixed.
- Pre-existing flake (NOT fixed here, reproduced on main's own suite): the
  forkserver path has an intermittent first-execute hang in fresh forked
  kernels; `kernel-state-roundtrip` flakes the same way on the shared venv
  with no GC code involved. Recorded in ADR-0059 consequences.

## Gotchas learned
- `bytearray`/`dict` are not weakref-able and bytearray is not GC-tracked;
  use lists (or user classes) for leak tests that must show up in
  `trackedObjects`.
- IPython caches every cell result in `Out` AND `_`/`__`/`___`; a "leak"
  scenario must clear all of them or the payload stays reachable forever.
- The forkserver template calls `gc.freeze()`; a forked kernel's collect can
  legitimately report 0 when garbage was already refcount-freed — cycle
  payloads make collected counts deterministic.
- `from . import gc` inside a module-level `__getattr__` recurses; use
  `importlib.import_module`.
