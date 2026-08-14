"""Garbage-collection pressure tracking and policy for the Axiom kernel.

The kernel is persistent: every cell's objects stay alive until the GC runs.
This module gives the host (and the kernel itself) visibility into how much
garbage is accumulating and a way to force collection.

Layering:

- ``measure_pressure()`` is the cheap, always-safe probe. Its default path
  reads the stdlib GC's per-generation counters (microseconds); the
  ``detailed=True`` path additionally walks all tracked objects once and the
  user-namespace reachable closure, and is meant for explicit host requests
  and tests, not per-cell use.
- ``collect()`` runs a full cyclic GC pass and reports before/after pressure,
  so callers can see what a pass actually freed.
- ``install_post_execute_gc()`` wires an IPython ``post_execute`` hook that
  runs a collection when pressure crosses a threshold. Two triggers run:
  a cheap per-cell check of the stdlib generation counters, and a periodic
  (every ``DEFAULT_TRACKED_CHECK_INTERVAL`` cells) tracked-object count that
  is the reachable default trigger. The hook is idempotent, safe to call
  outside a kernel (returns False), and never raises — a GC policy must
  never take down the kernel it protects.

Thresholds come from env vars (configurable per the issue scope):
``AXIOM_GC_MAX_UNCOLLECTED_OBJECTS``, ``AXIOM_GC_MAX_TRACKED_OBJECTS``,
``AXIOM_GC_MAX_ESTIMATED_BYTES``.
"""

from __future__ import annotations

import gc as _stdlib_gc
import os
import sys
from dataclasses import dataclass
from types import ModuleType
from typing import Any

try:
    from IPython import get_ipython
except Exception:  # pragma: no cover - only available inside kernels
    get_ipython = None  # type: ignore[assignment]

# Default thresholds. Chosen so a freshly booted kernel (tens of thousands of
# live objects after imports) never trips them, while a leaking session does.
#
# Ceilings matter: the cheap metric is ``sum(gc.get_count())``, the stdlib's
# per-generation allocation counters. CPython 3.11 thresholds are (700, 10,
# 10), so with automatic collections enabled the sum is structurally capped
# near 720 and peaks near 2000 only under extreme churn. A value far above
# that can never fire (the original 100 000 default was inert). 2 000 keeps
# the cheap check as a burst tripwire without pretending it bounds sessions.
DEFAULT_MAX_UNCOLLECTED_OBJECTS = 2_000
# Tracked objects (len(gc.get_objects())) grow monotonically with live+cyclic
# garbage, so this is the reachable default trigger. A freshly booted kernel
# holds tens of thousands; 250k leaves headroom while still bounding leaks.
DEFAULT_MAX_TRACKED_OBJECTS = 250_000
# Report-only: estimated_bytes is never used as a trigger (a sizeof sum over
# every tracked object costs too much to run periodically).
DEFAULT_MAX_ESTIMATED_BYTES = 1 << 30  # 1 GiB
# How often the post_execute hook pays for the tracked-object count (one full
# gc.get_objects() list build). 32 cells amortizes the cost to near nothing.
DEFAULT_TRACKED_CHECK_INTERVAL = 32
# Cap on the user-namespace closure walk so a pathological namespace can't make
# a detailed measurement unbounded.
DEFAULT_MAX_USER_CLOSURE_NODES = 200_000
# How many recent automatic collections gc_status() remembers.
_AUTO_COLLECT_LOG_LIMIT = 8

_NAMESPACE_SKIP = frozenset({"rlm", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open"})


@dataclass(frozen=True)
class GcThresholds:
    """Env-configurable GC thresholds.

    ``max_uncollected_objects`` (cheap per-cell trigger) and
    ``max_tracked_objects`` (periodic trigger) drive collections;
    ``max_estimated_bytes`` is report-only and never triggers a pass.
    """

    max_uncollected_objects: int
    max_tracked_objects: int
    max_estimated_bytes: int


def _env_int(environ: dict[str, str] | None, name: str, default: int) -> int:
    raw = (environ or {}).get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value >= 0 else default


def resolve_thresholds(environ: dict[str, str] | None = None) -> GcThresholds:
    """Resolve GC thresholds from env vars, defaulting when absent or invalid."""
    env = os.environ if environ is None else environ
    return GcThresholds(
        max_uncollected_objects=_env_int(env, "AXIOM_GC_MAX_UNCOLLECTED_OBJECTS", DEFAULT_MAX_UNCOLLECTED_OBJECTS),
        max_tracked_objects=_env_int(env, "AXIOM_GC_MAX_TRACKED_OBJECTS", DEFAULT_MAX_TRACKED_OBJECTS),
        max_estimated_bytes=_env_int(env, "AXIOM_GC_MAX_ESTIMATED_BYTES", DEFAULT_MAX_ESTIMATED_BYTES),
    )


def _safe_sizeof(obj: Any) -> int:
    try:
        return sys.getsizeof(obj)
    except Exception:  # pragma: no cover - an exotic __sizeof__ must not break the scan
        return 0


def _namespace_roots() -> dict[str, Any]:
    ip = None
    try:
        ip = get_ipython()  # type: ignore[misc]
    except Exception:  # pragma: no cover - kernel access must never raise
        ip = None
    ns: dict[str, Any] = ip.user_ns if ip is not None else globals()
    hidden: set[str] = set(getattr(ip, "user_ns_hidden", {}) or {}) if ip is not None else set()
    roots: dict[str, Any] = {}
    for name, value in ns.items():
        if name.startswith("_") or name in hidden or name in _NAMESPACE_SKIP:
            continue
        roots[name] = value
    return roots


def _user_closure_pressure(
    roots: dict[str, Any] | None = None,
    max_nodes: int = DEFAULT_MAX_USER_CLOSURE_NODES,
) -> tuple[int, int]:
    """Count objects and estimated bytes reachable from namespace roots.

    Modules are leaves (never descended), so importing numpy doesn't make the
    "user" count balloon to the whole interpreter. Shared references are
    counted once via id-dedup. The walk is bounded by ``max_nodes`` so a huge
    live namespace can't make a measurement itself unbounded.
    """
    source = _namespace_roots() if roots is None else roots
    seen: set[int] = set()
    pending: list[Any] = list(source.values())
    objects = 0
    bytes_ = 0
    while pending and objects < max_nodes:
        obj = pending.pop()
        object_id = id(obj)
        if object_id in seen:
            continue
        if isinstance(obj, ModuleType):
            # Modules are leaves (never descended), but still deduped so the
            # same module reached under several names counts once.
            seen.add(object_id)
            objects += 1
            bytes_ += _safe_sizeof(obj)
            continue
        seen.add(object_id)
        objects += 1
        bytes_ += _safe_sizeof(obj)
        try:
            pending.extend(_stdlib_gc.get_referents(obj))
        except Exception:  # pragma: no cover - a weird __dict__ must not break the walk
            continue
    return objects, bytes_


def measure_pressure(*, detailed: bool = False, tracked: bool = False) -> dict[str, Any]:
    """Snapshot kernel GC pressure.

    Cheap by default: generation counters and collection totals only, so it is
    safe to call after every cell. ``tracked=True`` adds only the tracked-object
    count (one ``gc.get_objects()`` list build, no sizeof sum) — the metric the
    automatic triggers use. ``detailed=True`` additionally sums estimated bytes
    and walks the user-namespace closure, and is meant for explicit host
    requests and tests, not per-cell checks.
    """
    counts = _stdlib_gc.get_count()
    stats = _stdlib_gc.get_stats()
    pressure: dict[str, Any] = {
        "uncollected_objects": sum(counts),
        "generation_counts": list(counts),
        "collected_objects": sum(entry.get("collected", 0) for entry in stats),
        "uncollectable_objects": sum(entry.get("uncollectable", 0) for entry in stats),
    }
    if tracked or detailed:
        objects = _stdlib_gc.get_objects()
        pressure["tracked_objects"] = len(objects)
        if detailed:
            pressure["estimated_bytes"] = sum(_safe_sizeof(obj) for obj in objects)
    if detailed:
        user_objects, user_bytes = _user_closure_pressure()
        pressure["user_objects"] = user_objects
        pressure["user_bytes"] = user_bytes
    return pressure


def collect(*, generation: int = 2, detailed: bool = False) -> dict[str, Any]:
    """Run a GC pass and report what it freed.

    ``generation`` follows stdlib semantics (0/1/2, 2 = full cyclic pass).
    Returns before/after pressure snapshots plus the number of unreachable
    objects found, so the caller can see whether the pass actually helped.
    """
    before = measure_pressure(detailed=detailed)
    collected = _stdlib_gc.collect(generation)
    after = measure_pressure(detailed=detailed)
    return {
        "collected": collected,
        "uncollectable": len(_stdlib_gc.garbage),
        "before": before,
        "after": after,
    }


# ---- automatic, threshold-based collection ---------------------------------

_hook_installed = False
_thresholds: GcThresholds | None = None
_auto_collect_log: list[dict[str, Any]] = []
# Cadence for the periodic tracked-object check (one gc.get_objects() list
# build per interval of post_execute invocations).
_cell_since_tracked_check = 0
_tracked_check_interval = DEFAULT_TRACKED_CHECK_INTERVAL


def _maybe_collect() -> None:
    """One post-execute check. Never raises: a GC policy must not kill the kernel.

    Two triggers, in order:

    - Cheap, every cell: the stdlib generation-counter sum. With automatic
      collections enabled CPython caps it near 720 (thresholds 700/10/10), so
      the default 2 000 is a burst tripwire, not a session bound. Operators
      can lower ``AXIOM_GC_MAX_UNCOLLECTED_OBJECTS`` for aggressive firing.
    - Periodic, every ``_tracked_check_interval`` cells: the tracked-object
      count. This grows with accumulated live and cyclic garbage and is the
      reachable default trigger. It fires on every periodic check while the
      count exceeds the threshold, so a session holding more than the
      threshold pays one full pass per interval (a bounded cost, ~1-2 ms per
      cell at hundreds of thousands of objects); no floor state is kept, so a
      slow leak can never hide below an anti-thrash baseline.
    """
    global _cell_since_tracked_check
    thresholds = _thresholds or resolve_thresholds()
    try:
        pressure = measure_pressure()
    except Exception:  # pragma: no cover - defensive
        return
    reason: str | None = None
    tracked_before: int | None = None
    if pressure["uncollected_objects"] >= thresholds.max_uncollected_objects:
        reason = "uncollected-threshold"
    else:
        _cell_since_tracked_check += 1
        if _cell_since_tracked_check >= _tracked_check_interval:
            _cell_since_tracked_check = 0
            try:
                tracked_before = len(_stdlib_gc.get_objects())
            except Exception:  # pragma: no cover - defensive
                tracked_before = None
            if tracked_before is not None and tracked_before > thresholds.max_tracked_objects:
                reason = "tracked-threshold"
    if reason is None:
        return
    try:
        collected = _stdlib_gc.collect()
    except Exception:  # pragma: no cover - defensive
        return
    _auto_collect_log.append(
        {
            "collected": collected,
            "uncollected_before": pressure["uncollected_objects"],
            "tracked_before": tracked_before,
            "reason": reason,
        }
    )
    del _auto_collect_log[: -_AUTO_COLLECT_LOG_LIMIT]


def install_post_execute_gc(thresholds: GcThresholds | None = None) -> bool:
    """Install the threshold-based post-execute GC hook. Idempotent.

    Safe to call outside a kernel (returns False). The hook itself never
    raises. ``thresholds`` overrides the env-resolved defaults for this
    kernel; calling again with new thresholds updates them without
    re-registering.
    """
    global _hook_installed, _thresholds
    if thresholds is not None:
        _thresholds = thresholds
    if _hook_installed:
        return True
    ip = None
    try:
        ip = get_ipython()  # type: ignore[misc]
    except Exception:  # pragma: no cover - defensive
        return False
    if ip is None or not hasattr(ip, "events"):
        return False
    try:
        ip.events.register("post_execute", _maybe_collect)
    except Exception:  # pragma: no cover - defensive
        return False
    _hook_installed = True
    return True


def gc_status() -> dict[str, Any]:
    """Observability view: thresholds, hook state, and recent auto-collects."""
    thresholds = _thresholds or resolve_thresholds()
    return {
        "hook_installed": _hook_installed,
        "tracked_check_interval": _tracked_check_interval,
        "thresholds": {
            "max_uncollected_objects": thresholds.max_uncollected_objects,
            "max_tracked_objects": thresholds.max_tracked_objects,
            "max_estimated_bytes": thresholds.max_estimated_bytes,
        },
        "auto_collects": list(_auto_collect_log),
    }


__all__ = [
    "DEFAULT_MAX_ESTIMATED_BYTES",
    "DEFAULT_MAX_TRACKED_OBJECTS",
    "DEFAULT_TRACKED_CHECK_INTERVAL",
    "DEFAULT_MAX_UNCOLLECTED_OBJECTS",
    "GcThresholds",
    "collect",
    "gc_status",
    "install_post_execute_gc",
    "measure_pressure",
    "resolve_thresholds",
]
