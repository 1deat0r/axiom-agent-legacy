"""Red-first tests for the kernel GC pressure module (rlm.gc).

These tests run under a plain Python (no IPython kernel): the module must
import and degrade gracefully when no shell exists, and every function must
be testable against fake shells and injected roots.
"""

from __future__ import annotations

import gc as stdlib_gc
import os
import unittest
from types import ModuleType
from unittest.mock import patch

from rlm import gc as kernel_gc
from rlm.gc import (
    DEFAULT_MAX_ESTIMATED_BYTES,
    DEFAULT_MAX_TRACKED_OBJECTS,
    DEFAULT_MAX_UNCOLLECTED_OBJECTS,
    GcThresholds,
    collect,
    gc_status,
    install_post_execute_gc,
    measure_pressure,
    resolve_thresholds,
)


def _make_garbage(count: int = 2000) -> None:
    # Build garbage that becomes unreachable the moment this frame exits: a
    # big list of bytearrays plus a reference cycle. Returning nothing keeps
    # no live reference to any of it.
    big = [bytearray(1024) for _ in range(count)]
    cycle: list[object] = []
    cycle.append(cycle)
    big.append(cycle)


class _FakeEvents:
    def __init__(self) -> None:
        self.handlers: list[tuple[str, object]] = []

    def register(self, name: str, fn: object) -> None:
        self.handlers.append((name, fn))


class _FakeShell:
    def __init__(self) -> None:
        self.events = _FakeEvents()


class GcPressureTest(unittest.TestCase):
    def test_measure_pressure_cheap_shape(self) -> None:
        pressure = measure_pressure()
        self.assertIsInstance(pressure["uncollected_objects"], int)
        self.assertIsInstance(pressure["generation_counts"], list)
        self.assertEqual(len(pressure["generation_counts"]), 3)
        self.assertIsInstance(pressure["collected_objects"], int)
        self.assertIsInstance(pressure["uncollectable_objects"], int)
        # Cheap path must not pay for the detailed scan.
        self.assertNotIn("tracked_objects", pressure)
        self.assertNotIn("estimated_bytes", pressure)

    def test_measure_pressure_detailed_shape(self) -> None:
        pressure = measure_pressure(detailed=True)
        self.assertGreater(pressure["tracked_objects"], 0)
        self.assertGreater(pressure["estimated_bytes"], 0)
        self.assertGreaterEqual(pressure["user_objects"], 0)
        self.assertGreaterEqual(pressure["user_bytes"], 0)
        self.assertEqual(
            pressure["uncollected_objects"],
            sum(pressure["generation_counts"]),
        )

    def test_collect_reports_drop_for_unreachable_garbage(self) -> None:
        # Most of the garbage is refcount-freed the moment _make_garbage's frame
        # exits; the cycle inside it survives for the cyclic collector. The
        # deterministic contract is the pressure drop, not the exact collected
        # count (that belongs to the pure-cycle test below).
        _make_garbage(2000)
        before = measure_pressure(detailed=True)
        result = collect(detailed=True)
        after = result["after"]
        self.assertGreaterEqual(result["collected"], 1)
        self.assertGreater(before["tracked_objects"], after["tracked_objects"])
        self.assertGreater(before["uncollected_objects"], after["uncollected_objects"])
        self.assertIn("before", result)
        self.assertIn("after", result)

    def test_collect_reports_pure_cycle_garbage(self) -> None:
        cycle: list[object] = []
        cycle.append(cycle)
        del cycle
        result = collect()
        self.assertGreaterEqual(result["collected"], 1)
        self.assertEqual(result["uncollectable"], len(stdlib_gc.garbage))

    def test_user_closure_counts_reachable_objects(self) -> None:
        roots = {"data": [bytearray(8) for _ in range(300)]}
        objects, bytes_ = kernel_gc._user_closure_pressure(roots=roots)
        # The list plus its 300 bytearrays (bytearray contents are not objects).
        self.assertGreaterEqual(objects, 301)
        self.assertGreater(bytes_, 0)

    def test_user_closure_treats_modules_as_leaves(self) -> None:
        objects, bytes_ = kernel_gc._user_closure_pressure(roots={"mod": os})
        # The module object is counted once and never descended into.
        self.assertEqual(objects, 1)
        self.assertGreater(bytes_, 0)

    def test_user_closure_dedups_shared_references(self) -> None:
        shared = bytearray(4)
        objects, _ = kernel_gc._user_closure_pressure(roots={"a": [shared], "b": [shared]})
        # Two lists plus one shared bytearray, counted once.
        self.assertEqual(objects, 3)

    def test_user_closure_bounds_walk_at_max_nodes(self) -> None:
        roots = {"data": [bytearray(8) for _ in range(10)]}
        objects, _ = kernel_gc._user_closure_pressure(roots=roots, max_nodes=5)
        self.assertLessEqual(objects, 5)


class GcThresholdsTest(unittest.TestCase):
    def test_resolve_thresholds_defaults(self) -> None:
        thresholds = resolve_thresholds(environ={})
        self.assertEqual(thresholds.max_uncollected_objects, DEFAULT_MAX_UNCOLLECTED_OBJECTS)
        self.assertEqual(thresholds.max_tracked_objects, DEFAULT_MAX_TRACKED_OBJECTS)
        self.assertEqual(thresholds.max_estimated_bytes, DEFAULT_MAX_ESTIMATED_BYTES)

    def test_resolve_thresholds_reads_env(self) -> None:
        thresholds = resolve_thresholds(
            environ={
                "AXIOM_GC_MAX_UNCOLLECTED_OBJECTS": "42",
                "AXIOM_GC_MAX_TRACKED_OBJECTS": "43",
                "AXIOM_GC_MAX_ESTIMATED_BYTES": "44",
            }
        )
        self.assertEqual(thresholds, GcThresholds(42, 43, 44))

    def test_resolve_thresholds_ignores_invalid_env(self) -> None:
        thresholds = resolve_thresholds(
            environ={
                "AXIOM_GC_MAX_UNCOLLECTED_OBJECTS": "nope",
                "AXIOM_GC_MAX_TRACKED_OBJECTS": "-3",
                "AXIOM_GC_MAX_ESTIMATED_BYTES": "",
            }
        )
        self.assertEqual(thresholds, GcThresholds(DEFAULT_MAX_UNCOLLECTED_OBJECTS, DEFAULT_MAX_TRACKED_OBJECTS, DEFAULT_MAX_ESTIMATED_BYTES))

    def test_resolve_thresholds_defaults_to_process_env(self) -> None:
        with patch.dict(os.environ, {"AXIOM_GC_MAX_UNCOLLECTED_OBJECTS": "77"}, clear=False):
            thresholds = resolve_thresholds()
            self.assertEqual(thresholds.max_uncollected_objects, 77)


class PostExecuteHookTest(unittest.TestCase):
    def setUp(self) -> None:
        # Each test starts from a clean module-level hook state.
        kernel_gc._hook_installed = False
        kernel_gc._thresholds = None
        kernel_gc._auto_collect_log.clear()

    def test_install_without_shell_returns_false(self) -> None:
        with patch.object(kernel_gc, "get_ipython", return_value=None):
            self.assertFalse(install_post_execute_gc())

    def test_install_registers_once_and_runs_collect(self) -> None:
        shell = _FakeShell()
        with patch.object(kernel_gc, "get_ipython", return_value=shell):
            self.assertTrue(install_post_execute_gc(GcThresholds(0, 0, 0)))
            self.assertTrue(install_post_execute_gc(GcThresholds(0, 0, 0)))
        self.assertEqual(len(shell.events.handlers), 1)
        name, handler = shell.events.handlers[0]
        self.assertEqual(name, "post_execute")

        _make_garbage(100)
        handler()  # type: ignore[operator]
        status = gc_status()
        self.assertGreaterEqual(len(status["auto_collects"]), 1)
        self.assertGreater(status["auto_collects"][-1]["collected"], 0)

    def test_hook_skips_collect_below_threshold(self) -> None:
        shell = _FakeShell()
        huge = GcThresholds(10**9, 10**9, 10**12)
        with patch.object(kernel_gc, "get_ipython", return_value=shell):
            install_post_execute_gc(huge)
        _make_garbage(50)
        name, handler = shell.events.handlers[0]
        handler()  # type: ignore[operator]
        self.assertEqual(gc_status()["auto_collects"], [])

    def test_hook_never_raises_when_measurement_fails(self) -> None:
        shell = _FakeShell()
        with patch.object(kernel_gc, "get_ipython", return_value=shell):
            install_post_execute_gc(GcThresholds(0, 0, 0))
        name, handler = shell.events.handlers[0]
        with patch.object(kernel_gc._stdlib_gc, "get_count", side_effect=RuntimeError("boom")):
            handler()  # type: ignore[operator] -- must not raise
        self.assertEqual(gc_status()["auto_collects"], [])

    def test_gc_status_reports_thresholds_and_hook_state(self) -> None:
        shell = _FakeShell()
        with patch.object(kernel_gc, "get_ipython", return_value=shell):
            install_post_execute_gc(GcThresholds(5, 6, 7))
        status = gc_status()
        self.assertTrue(status["hook_installed"])
        self.assertEqual(status["thresholds"], {"max_uncollected_objects": 5, "max_tracked_objects": 6, "max_estimated_bytes": 7})

    def test_auto_collect_log_is_bounded(self) -> None:
        kernel_gc._thresholds = GcThresholds(0, 0, 0)
        for _ in range(12):
            kernel_gc._maybe_collect()
        self.assertLessEqual(len(gc_status()["auto_collects"]), 8)


if __name__ == "__main__":
    unittest.main()
