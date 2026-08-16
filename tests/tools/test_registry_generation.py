"""ADR-0093 — the registry generation public seam.

``ToolRegistry.generation()`` is the public read for the monotonic
registration counter; ``restore_registration`` bumps it like every other
mutation. ``model_tools.TOOL_TO_TOOLSET_MAP`` / ``TOOLSET_REQUIREMENTS``
become live snapshots — re-resolved from the registry on every access —
so MCP refresh / plugin (un)load cannot leave them stale.
"""

import json

from tools.registry import ToolRegistry, registry as _global_registry


def _dummy_handler(args, **kwargs):
    return json.dumps({"ok": True})


def _make_schema(name):
    return {
        "name": name,
        "description": f"A {name}",
        "parameters": {"type": "object", "properties": {}},
    }


class TestGenerationSeam:
    def test_generation_is_public_and_bumped_by_mutations(self):
        reg = ToolRegistry()
        g0 = reg.generation()
        reg.register(
            name="gen_a", toolset="gen_ts", schema=_make_schema("gen_a"),
            handler=_dummy_handler,
        )
        g1 = reg.generation()
        reg.register(
            name="gen_b", toolset="gen_ts", schema=_make_schema("gen_b"),
            handler=_dummy_handler,
        )
        g2 = reg.generation()
        reg.deregister("gen_b")
        g3 = reg.generation()
        assert g1 > g0
        assert g2 > g1
        assert g3 > g2

    def test_restore_registration_bumps_generation(self):
        reg = ToolRegistry()
        reg.register(
            name="gen_c", toolset="gen_ts", schema=_make_schema("gen_c"),
            handler=_dummy_handler,
        )
        current = reg.snapshot_registration("gen_c")
        assert current is not None
        reg.register(
            name="gen_c", toolset="gen_ts", schema=_make_schema("gen_c_v2"),
            handler=_dummy_handler,
        )
        mid = reg.generation()
        assert reg.snapshot_registration("gen_c") is not current
        restored = reg.restore_registration(
            "gen_c", reg.snapshot_registration("gen_c"), current
        )
        assert restored is True
        assert reg.snapshot_registration("gen_c") is current
        # ADR-0093: restore must invalidate memo caches like every mutation.
        assert reg.generation() > mid


class TestLiveSnapshotShims:
    def test_tool_to_toolset_map_is_live(self):
        _global_registry.register(
            name="live_gen_tool", toolset="live_gen_ts",
            schema=_make_schema("live_gen_tool"), handler=_dummy_handler,
        )
        try:
            import model_tools

            assert model_tools.TOOL_TO_TOOLSET_MAP["live_gen_tool"] == "live_gen_ts"
            assert "live_gen_ts" in model_tools.TOOLSET_REQUIREMENTS
        finally:
            _global_registry.deregister("live_gen_tool")

        # A fresh access after deregistration sees the removal — no re-import.
        import model_tools

        assert "live_gen_tool" not in model_tools.TOOL_TO_TOOLSET_MAP
        assert "live_gen_ts" not in model_tools.TOOLSET_REQUIREMENTS
