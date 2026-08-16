"""ADR-0090 — the tool dispatch seam.

Every tool call crosses one seam: the registry. Agent-level tools register an
``agent_executor`` beside their schema/handler; the sequential and concurrent
executors resolve it from the registry instead of name-forking. These tests pin
that contract red-first.

Characterization invariants that must stay green across the refactor:
- the pre-hook block path never runs the executor (counter semantics preserved);
- post_tool_call fires exactly once per executor path;
- agent-level tools never reach ``handle_function_call``.
"""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from run_agent import AIAgent


def _make_tool_defs(names):
    return [
        {
            "type": "function",
            "function": {
                "name": n,
                "description": f"{n} tool",
                "parameters": {"type": "object", "properties": {}},
            },
        }
        for n in names
    ]


@pytest.fixture()
def agent():
    """Minimal AIAgent with mocked OpenAI client and tool loading."""
    with (
        patch(
            "run_agent.get_tool_definitions", return_value=_make_tool_defs("web_search")
        ),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        a = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
        )
        a.client = MagicMock()
        a.session_id = "seam-session"
        return a


def _mock_tool_call(name="web_search", arguments="{}", call_id="c1"):
    return SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(name=name, arguments=arguments),
    )


def _mock_assistant_msg(content="", tool_calls=None):
    return SimpleNamespace(content=content, tool_calls=tool_calls or [])


@pytest.fixture()
def seam_tool():
    """Register a fake tool with an agent_executor; deregister on teardown."""
    from tools.registry import registry

    calls = []

    def executor(agent_obj, args, ctx):
        calls.append((agent_obj, dict(args), dict(ctx)))
        return json.dumps({"executor": True})

    registry.register(
        name="seam_fake_tool",
        toolset="seam_test",
        schema={
            "name": "seam_fake_tool",
            "description": "seam test tool",
            "parameters": {"type": "object", "properties": {}},
        },
        handler=lambda args, **kw: json.dumps({"handler": True}),
        agent_executor=executor,
    )
    yield {"name": "seam_fake_tool", "calls": calls}
    registry.deregister("seam_fake_tool")


# =========================================================================
# The registry seam (new contract — red until implemented)
# =========================================================================

class TestRegistryExecutorContract:
    def test_dispatch_agent_executor_runs_registered_executor(self, seam_tool):
        from tools.registry import registry

        fake_agent = MagicMock()
        result = registry.dispatch_agent_executor(
            "seam_fake_tool", fake_agent, {"a": 1}, {"task_id": "t1"}
        )
        assert json.loads(result) == {"executor": True}
        assert seam_tool["calls"][0][0] is fake_agent
        assert seam_tool["calls"][0][1] == {"a": 1}
        assert seam_tool["calls"][0][2] == {"task_id": "t1"}

    def test_dispatch_agent_executor_returns_none_without_executor(self):
        from tools.registry import registry

        assert registry.dispatch_agent_executor("web_search", MagicMock(), {}, {}) is None

    def test_get_after_authorization_returns_registered_hook(self):
        from tools.registry import registry

        seen = []
        registry.register(
            name="seam_hook_tool",
            toolset="seam_test",
            schema={
                "name": "seam_hook_tool",
                "description": "seam hook tool",
                "parameters": {"type": "object", "properties": {}},
            },
            handler=lambda args, **kw: json.dumps({"ok": True}),
            after_authorization=lambda agent_obj: seen.append(agent_obj),
        )
        try:
            hook = registry.get_after_authorization("seam_hook_tool")
            assert hook is not None
            hook("agent-obj")
            assert seen == ["agent-obj"]
            assert registry.get_after_authorization("web_search") is None
        finally:
            registry.deregister("seam_hook_tool")

    def test_all_agent_level_tools_register_executors(self):
        from tools.registry import registry

        for name in (
            "todo",
            "session_search",
            "memory",
            "clarify",
            "read_terminal",
            "read_preview",
            "read_window_below",
            "setup_mcp",
            "delegate_task",
        ):
            assert registry.get_agent_executor(name) is not None, name


# =========================================================================
# Both executor paths cross the registry seam
# =========================================================================

class TestExecutorPathsCrossRegistry:
    def test_sequential_path_runs_registry_executor(self, agent, seam_tool, monkeypatch):
        from tools.registry import registry

        monkeypatch.setattr(
            "hermes_cli.plugins._dispatch_pre_tool_call_hooks",
            lambda *args, **kwargs: (None, None),
        )
        tool_call = _mock_tool_call(
            name="seam_fake_tool", arguments='{"a": 1}', call_id="seq-1"
        )
        messages = []
        # ADR-0090 Decision #3: the executor path resolves through
        # registry.dispatch_agent_executor — pin the production seam, not a
        # direct executor invocation.
        with patch.object(
            registry, "dispatch_agent_executor", wraps=registry.dispatch_agent_executor
        ) as _spy, patch(
            "run_agent.handle_function_call",
            side_effect=AssertionError("executor tools must not reach handle_function_call"),
        ):
            agent._execute_tool_calls_sequential(
                _mock_assistant_msg(tool_calls=[tool_call]), messages, "task-seq"
            )

        assert _spy.called, "executor path must cross registry.dispatch_agent_executor"
        assert seam_tool["calls"], "executor was not invoked"
        called_agent, args, ctx = seam_tool["calls"][0]
        assert called_agent is agent
        assert args == {"a": 1}
        assert ctx["task_id"] == "task-seq"
        assert ctx["tool_call_id"] == "seq-1"
        assert set(ctx) == {"task_id", "tool_call_id", "session_id", "turn_id", "api_request_id"}
        assert any(
            json.loads(m["content"]) == {"executor": True} if isinstance(m["content"], str) else False
            for m in messages
        )

    def test_invoke_tool_runs_registry_executor(self, agent, seam_tool, monkeypatch):
        from tools.registry import registry

        monkeypatch.setattr(
            "hermes_cli.plugins._dispatch_pre_tool_call_hooks",
            lambda *args, **kwargs: (None, None),
        )
        with patch.object(
            registry, "dispatch_agent_executor", wraps=registry.dispatch_agent_executor
        ) as _spy, patch(
            "run_agent.handle_function_call",
            side_effect=AssertionError("executor tools must not reach handle_function_call"),
        ):
            result = agent._invoke_tool(
                "seam_fake_tool", {"a": 1}, "task-concurrent", tool_call_id="conc-1"
            )

        assert _spy.called, "executor path must cross registry.dispatch_agent_executor"
        assert json.loads(result) == {"executor": True}
        assert seam_tool["calls"][0][2]["task_id"] == "task-concurrent"
        assert seam_tool["calls"][0][2]["tool_call_id"] == "conc-1"

    def test_blocked_executor_tool_never_runs(self, agent, seam_tool, monkeypatch):
        from tools.registry import registry

        registry.deregister("seam_fake_tool")
        try:
            registry.register(
                name="seam_fake_tool",
                toolset="seam_test",
                schema={
                    "name": "seam_fake_tool",
                    "description": "seam test tool",
                    "parameters": {"type": "object", "properties": {}},
                },
                handler=lambda args, **kw: json.dumps({"handler": True}),
                agent_executor=lambda agent_obj, args, ctx: (_ for _ in ()).throw(
                    AssertionError("blocked executor must not run")
                ),
            )
            monkeypatch.setattr(
                "hermes_cli.plugins._dispatch_pre_tool_call_hooks",
                lambda *args, **kwargs: ("Blocked by policy", None),
            )
            result = agent._invoke_tool("seam_fake_tool", {"a": 1}, "task-1")
        finally:
            registry.deregister("seam_fake_tool")

        assert json.loads(result) == {"error": "Blocked by policy"}

    def test_after_authorization_hook_runs_when_not_blocked(self, agent, monkeypatch):
        """The hook fires in the authorized-dispatch stage (sequential path),
        preserving the pre-refactor timing exactly — post-guardrails,
        pre-execute."""
        from tools.registry import registry

        seen = []
        registry.register(
            name="seam_hook2_tool",
            toolset="seam_test",
            schema={
                "name": "seam_hook2_tool",
                "description": "seam hook tool 2",
                "parameters": {"type": "object", "properties": {}},
            },
            handler=lambda args, **kw: json.dumps({"ok": True}),
            agent_executor=lambda agent_obj, args, ctx: json.dumps({"ok": True}),
            after_authorization=lambda agent_obj: seen.append("authorized"),
        )
        try:
            monkeypatch.setattr(
                "hermes_cli.plugins._dispatch_pre_tool_call_hooks",
                lambda *args, **kwargs: (None, None),
            )
            tool_call = _mock_tool_call(name="seam_hook2_tool", arguments="{}", call_id="hook-1")
            with patch(
                "run_agent.handle_function_call",
                side_effect=AssertionError("executor tools must not reach handle_function_call"),
            ):
                agent._execute_tool_calls_sequential(
                    _mock_assistant_msg(tool_calls=[tool_call]), [], "task-hook"
                )
            assert seen == ["authorized"]
        finally:
            registry.deregister("seam_hook2_tool")

    def test_after_authorization_hook_skipped_when_blocked(self, agent, monkeypatch):
        """A blocked call never fires the hook (the counter-reset invariant)."""
        from tools.registry import registry

        seen = []
        registry.register(
            name="seam_hook3_tool",
            toolset="seam_test",
            schema={
                "name": "seam_hook3_tool",
                "description": "seam hook tool 3",
                "parameters": {"type": "object", "properties": {}},
            },
            handler=lambda args, **kw: json.dumps({"ok": True}),
            agent_executor=lambda agent_obj, args, ctx: (_ for _ in ()).throw(
                AssertionError("blocked executor must not run")
            ),
            after_authorization=lambda agent_obj: seen.append("authorized"),
        )
        try:
            monkeypatch.setattr(
                "hermes_cli.plugins._dispatch_pre_tool_call_hooks",
                lambda *args, **kwargs: ("Blocked by policy", None),
            )
            result = agent._invoke_tool("seam_hook3_tool", {}, "task-1")
            assert json.loads(result) == {"error": "Blocked by policy"}
            assert seen == []
        finally:
            registry.deregister("seam_hook3_tool")


# =========================================================================
# The dead-end stub dies (uniform agent-less degradation)
# =========================================================================

class TestAgentLoopStubRemoved:
    @pytest.mark.parametrize(
        "tool_name", ["todo", "memory", "session_search", "delegate_task"]
    )
    def test_handle_function_call_no_longer_stubs_agent_tools(self, tool_name):
        """The stub is gone: each tool degrades through its own registry
        handler (error or harmless browse-mode result) — never a name-list
        rejection."""
        from model_tools import handle_function_call

        result = handle_function_call(tool_name, {})
        assert "agent loop" not in json.dumps(result).lower()


# =========================================================================
# Observability context wraps every dispatch
# =========================================================================

class TestObservabilityContextWrapsExecutorDispatch:
    def test_sequential_executor_path_sets_and_resets_observability(self, agent, seam_tool, monkeypatch):
        monkeypatch.setattr(
            "hermes_cli.plugins._dispatch_pre_tool_call_hooks",
            lambda *args, **kwargs: (None, None),
        )
        set_calls = []
        reset_calls = []
        monkeypatch.setattr(
            "tools.approval.set_current_observability_context",
            lambda turn_id=None, tool_call_id=None, session_id=None: (
                set_calls.append((turn_id, tool_call_id, session_id))
                or ("tok-turn", "tok-call", "tok-sess")
            ),
        )
        monkeypatch.setattr(
            "tools.approval.reset_current_observability_context",
            lambda tokens: reset_calls.append(tokens),
        )
        tool_call = _mock_tool_call(name="seam_fake_tool", arguments="{}", call_id="obs-1")
        with patch(
            "run_agent.handle_function_call",
            side_effect=AssertionError("executor tools must not reach handle_function_call"),
        ):
            agent._execute_tool_calls_sequential(
                _mock_assistant_msg(tool_calls=[tool_call]), [], "task-obs"
            )

        assert set_calls, "observability context was never set for the executor path"
        assert set_calls[0][1] == "obs-1"
        assert reset_calls == [("tok-turn", "tok-call", "tok-sess")]
