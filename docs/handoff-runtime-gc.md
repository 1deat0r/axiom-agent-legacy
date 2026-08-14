# Handoff — runtime GC (issue #37, ADR-0059)

## What was done
Added real garbage collection to the persistent Python runtime, in three
layers (details in ADR-0059):

1. **Runtime module `axiom-runtime/src/rlm/gc.py`**
   - `measure_pressure(detailed=False)`: cheap per-generation counters by
     default; `detailed=True` adds tracked-object count, estimated bytes
     (getsizeof sum, failures tolerated), and the user-namespace reachable
     closure (BFS from `user_ns` roots, modules as leaves, id-dedup, capped).
   - `collect()`: full cyclic pass reporting before/after pressure +
     found-unreachable count.
   - `install_post_execute_gc()`: idempotent post-execute hook that collects
     when uncollected objects cross `AXIOM_GC_MAX_UNCOLLECTED_OBJECTS`
     (default 100k). Never raises; safe outside a kernel.
   - `resolve_thresholds()` / `gc_status()`: env-tunable thresholds
     (also `AXIOM_GC_MAX_TRACKED_OBJECTS` 1M, `AXIOM_GC_MAX_ESTIMATED_BYTES`
     1 GiB) + observability (hook state, last 8 auto-collects).
   - `rlm/__init__.py` exports `gc` lazily (importlib, not package-relative,
     to avoid `__getattr__` recursion).

2. **Host surface `kernel-gc.ts` + `KernelManager`**
   - `gcPressure(detailed?)` / `collectGarbage()`: synthetic internal cells
     with marker-line parsing (same pattern as state-snapshot).
   - Opt-in per-N-cell check (`KernelGcOptions.checkEveryNCells`, env
     `AXIOM_GC_CHECK_EVERY_N_CELLS`): every Nth successful user cell gets
     `result.gc = {pressure, collect?}`; a collect runs when cheap pressure
     crosses the threshold. The check runs after the execution-queue slot is
     released so its synthetic cells cannot self-deadlock.
   - `IpythonToolDetails.gc` carries the metadata into session tool-call
     details (turn metadata). `IpythonToolOptions.gc` plumbs the option.
   - `RUNTIME_READY_CHECK` now asserts the `rlm.gc` surface so stale venvs /
     `AXIOM_KERNEL_PYTHON` fail fast with a clear message.

3. **Bootstrap wiring**: `RLM_BOOTSTRAP_BASE_CODE` installs the
   post-execute GC hook per kernel (wrapped in try/except, never breaks
   bootstrap).

## Verification (unit / mock / live — labeled)
- **Unit (Python)**: `axiom-runtime/test/test_gc.py`, 18 tests, all green
  under plain python3 (no IPython needed): pressure shape (cheap/detailed),
  collect frees unreachable garbage (refcount + pure cycle), closure counting
  (reachable objects, module leaves, dedup, node cap), threshold env parsing,
  hook install/idempotence/threshold-skip/never-raise/log bound.
- **Unit (TS)**: `test/kernel-gc.test.ts` pure tests, 12 green: cell
  builders, marker parsing (cheap/detailed/collect, error/malformed/missing),
  `resolveGcOptionsFromEnv` (off by default, overrides, invalid values).
- **Live (real kernel)**: same file, 4 kernel-heavy tests against a scratch
  venv (`/tmp/axiom-gc-venv`, Python 3.11, ipykernel + new runtime): leak
  scenario (allocate 5000 GC-tracked lists in a self-cycle -> detailed
  pressure sees them -> `del` + collect frees them -> user/tracked counts
  drop by >= 5000); per-N metadata attach below threshold; auto-collect pass
  at threshold 0; off-by-default no-regression. The tests pin
  `AXIOM_KERNEL_FORKSERVER=0` (repo convention, see ipython-provisioner).
- **Floor**: `./test.sh` result recorded in the report file.

## Not done / follow-ups (honest)
- `estimated_bytes` uses `sys.getsizeof`, so it undercounts objects owning
  memory outside their allocation (bytearrays, numpy arrays); those types are
  also not GC-tracked, so counts don't see them. The contract is counts, not
  RSS. A tracemalloc-based sampler is a possible follow-up.
- The per-N-cell metadata check is off by default; enabling it on the live
  gateway is an operator knob (`AXIOM_GC_CHECK_EVERY_N_CELLS`), not yet set.
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
