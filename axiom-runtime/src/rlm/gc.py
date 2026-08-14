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
  runs a collection whenever uncollected objects exceed a threshold. It is
  idempotent, safe to call outside a kernel (returns False), and its hook
  never raises — a GC policy must never take down the kernel it protects.

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
DEFAULT_MAX_UNCOLLECTED_OBJECTS = 100_000
DEFAULT_MAX_TRACKED_OBJECTS = 1_000_000
DEFAULT_MAX_ESTIMATED_BYTES = 1 << 30  # 1 GiB
# Cap on the user-namespace closure walk so a pathological namespace can't make
# a detailed measurement unbounded.
DEFAULT_MAX_USER_CLOSURE_NODES = 200_000
# How many recent automatic collections gc_status() remembers.
_AUTO_COLLECT_LOG_LIMIT = 8

_NAMESPACE_SKIP = frozenset({"rlm", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open"})


@dataclass(frozen=True)
class GcThresholds:
    """Env-configurable triggers for a GC pass."""

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
        if isinstance(obj, ModuleType):
            objects += 1
            bytes_ += _safe_sizeof(obj)
            continue
        object_id = id(obj)
        if object_id in seen:
            continue
        seen.add(object_id)
        objects += 1
        bytes_ += _safe_sizeof(obj)
        try:
            pending.extend(_stdlib_gc.get_referents(obj))
        except Exception:  # pragma: no cover - a weird __dict__ must not break the walk
            continue
    return objects, bytes_


def measure_pressure(*, detailed: bool = False) -> dict[str, Any]:
    """Snapshot kernel GC pressure.

    Cheap by default: generation counters and collection totals only, so it is
    safe to call after every cell. ``detailed=True`` adds a full tracked-object
    scan (count + estimated bytes) and the user-namespace closure, and should
    be used for explicit host requests rather than per-cell checks.
    """
    counts = _stdlib_gc.get_count()
    stats = _stdlib_gc.get_stats()
    pressure: dict[str, Any] = {
        "uncollected_objects": sum(counts),
        "generation_counts": list(counts),
        "collected_objects": sum(entry.get("collected", 0) for entry in stats),
        "uncollectable_objects": sum(entry.get("uncollectable", 0) for entry in stats),
    }
    if detailed:
        tracked = _stdlib_gc.get_objects()
        user_objects, user_bytes = _user_closure_pressure()
        pressure["tracked_objects"] = len(tracked)
        pressure["estimated_bytes"] = sum(_safe_sizeof(obj) for obj in tracked)
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


def _maybe_collect() -> None:
    """One post-execute check. Never raises: a GC policy must not kill the kernel."""
    try:
        pressure = measure_pressure()
    except Exception:  # pragma: no cover - defensive
        return
    thresholds = _thresholds or resolve_thresholds()
    if pressure["uncollected_objects"] < thresholds.max_uncollected_objects:
        return
    try:
        collected = _stdlib_gc.collect()
    except Exception:  # pragma: no cover - defensive
        return
    _auto_collect_log.append(
        {
            "collected": collected,
            "uncollected_before": pressure["uncollected_objects"],
            "reason": "uncollected-threshold",
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
    "DEFAULT_MAX_UNCOLLECTED_OBJECTS",
    "GcThresholds",
    "collect",
    "gc_status",
    "install_post_execute_gc",
    "measure_pressure",
    "resolve_thresholds",
]
