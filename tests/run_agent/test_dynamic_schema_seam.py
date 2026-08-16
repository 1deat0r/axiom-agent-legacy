"""ADR-0091 — the dynamic-schema seam.

``dynamic_schema_overrides`` becomes context-aware: callables that accept a
parameter receive the check_fn-filtered ``available_tool_names`` frozenset;
returning a dict merges into the schema, returning None drops the tool.
Zero-arg callables keep working unchanged. The four assembler name-cases in
``model_tools._compute_tool_definitions`` move onto this seam, registered
beside each tool.

Seam A — the registry interface (unit).
Seam B — ``get_tool_definitions`` (end-to-end behavior).
"""

import json

import pytest

from tools.registry import registry


@pytest.fixture()
def _seam_tools():
    """Register fake tools for the registry seam tests; deregister on teardown."""
    registered = []

    def register(name, **kwargs):
        registry.register(
            name=name,
            toolset="seam_dyn_test",
            schema={
                "name": name,
                "description": f"static {name}",
                "parameters": {"type": "object", "properties": {}},
            },
            handler=lambda args, **kw: json.dumps({"ok": True}),
            **kwargs,
        )
        registered.append(name)

    yield register
    for name in registered:
        registry.deregister(name)


class TestRegistryDynamicSchemaSeam:
    def test_override_receives_available_tool_names(self, _seam_tools):
        """ADR-0091: a context-accepting override gets the check_fn-filtered
        frozenset of candidate names — the tool whose check fails is absent."""
        captured = []

        def override(available_tool_names):
            captured.append(available_tool_names)
            return {}

        _seam_tools("dyn_ctx_a", dynamic_schema_overrides=override)
        _seam_tools("dyn_ctx_b", check_fn=lambda: False)
        _seam_tools("dyn_ctx_c")

        defs = registry.get_definitions({"dyn_ctx_a", "dyn_ctx_b", "dyn_ctx_c"})
        assert {d["function"]["name"] for d in defs} == {"dyn_ctx_a", "dyn_ctx_c"}
        assert len(captured) == 1
        assert isinstance(captured[0], frozenset)
        assert captured[0] == frozenset({"dyn_ctx_a", "dyn_ctx_c"})

    def test_override_merge_partial_dict(self, _seam_tools):
        _seam_tools(
            "dyn_merge",
            dynamic_schema_overrides=lambda available_tool_names: {"description": "dynamic"},
        )
        defs = registry.get_definitions({"dyn_merge"})
        assert defs[0]["function"]["description"] == "dynamic"

    def test_override_none_drops_tool(self, _seam_tools):
        """ADR-0091: returning None removes the tool from the definitions —
        this is how browser_exec's session gate and discord's probe-failure
        removal express themselves."""
        _seam_tools(
            "dyn_drop",
            dynamic_schema_overrides=lambda available_tool_names: None,
        )
        defs = registry.get_definitions({"dyn_drop"})
        assert defs == []

    def test_drops_propagate_to_later_overrides(self, _seam_tools):
        """A tool dropped by its own override disappears from the set later
        overrides see — cross-tool conditions observe what actually ships."""
        captured = []
        # "dyn_drop_a" sorts before "dyn_see" — the drop applies first.
        _seam_tools(
            "dyn_drop_a",
            dynamic_schema_overrides=lambda available_tool_names: None,
        )
        _seam_tools(
            "dyn_see",
            dynamic_schema_overrides=lambda available_tool_names: (
                captured.append(available_tool_names) or {}
            ),
        )
        defs = registry.get_definitions({"dyn_drop_a", "dyn_see"})
        assert {d["function"]["name"] for d in defs} == {"dyn_see"}
        assert captured[0] == frozenset({"dyn_see"})

    def test_zero_arg_override_still_works(self, _seam_tools):
        """Zero-arg callables (delegate, image-gen, video-gen) keep the old
        contract — the registry must not pass them the context."""

        def override():
            return {"description": "zero-arg"}

        _seam_tools("dyn_zero", dynamic_schema_overrides=override)
        defs = registry.get_definitions({"dyn_zero"})
        assert defs[0]["function"]["description"] == "zero-arg"


class TestDynamicSchemaEndToEnd:
    """Seam B — the four assembler rewrites, pinned through
    get_tool_definitions (behavioral, no assembler internals)."""

    def _patch_check(self, monkeypatch, name, value):
        entry = registry.get_entry(name)
        assert entry is not None, name
        monkeypatch.setattr(entry, "check_fn", lambda: value)

    def test_execute_code_description_excludes_unavailable_sandbox_tools(self):
        import model_tools

        defs = model_tools.get_tool_definitions(
            enabled_toolsets=["code_execution"], quiet_mode=True
        )
        exec_tool = next(
            (t for t in defs if t["function"]["name"] == "execute_code"), None
        )
        assert exec_tool is not None
        assert "web_search" not in exec_tool["function"]["description"]

    def test_execute_code_description_includes_available_sandbox_tools(self, monkeypatch):
        self._patch_check(monkeypatch, "web_search", True)
        self._patch_check(monkeypatch, "web_extract", True)
        import model_tools

        defs = model_tools.get_tool_definitions(
            enabled_toolsets=["code_execution", "web"], quiet_mode=True
        )
        exec_tool = next(
            (t for t in defs if t["function"]["name"] == "execute_code"), None
        )
        assert exec_tool is not None
        assert "web_search" in exec_tool["function"]["description"]

    def test_browser_navigate_strips_web_crossref_without_web_tools(self, monkeypatch):
        # The ``browser`` toolset ships web_search, so the web tools must be
        # subtracted explicitly to build the without-web session shape.
        self._patch_check(monkeypatch, "browser_navigate", True)
        import model_tools

        defs = model_tools.get_tool_definitions(
            enabled_toolsets=["browser"],
            disabled_toolsets=["web"],
            quiet_mode=True,
        )
        nav = next(
            (t for t in defs if t["function"]["name"] == "browser_navigate"), None
        )
        assert nav is not None
        assert "prefer web_search or web_extract" not in nav["function"]["description"]

    def test_browser_navigate_keeps_web_crossref_with_web_tools(self, monkeypatch):
        self._patch_check(monkeypatch, "browser_navigate", True)
        self._patch_check(monkeypatch, "web_search", True)
        self._patch_check(monkeypatch, "web_extract", True)
        import model_tools

        defs = model_tools.get_tool_definitions(
            enabled_toolsets=["browser", "web"], quiet_mode=True
        )
        nav = next(
            (t for t in defs if t["function"]["name"] == "browser_navigate"), None
        )
        assert nav is not None
        assert "prefer web_search or web_extract" in nav["function"]["description"]
