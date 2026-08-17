"""Oneshot (-z) spend-cap threading (ADR-0011 regression).

The cap is threaded through ``cmd_chat`` -> ``cli.main`` -> ``AIAgent``, but
the ``-z`` one-shot path built ``AIAgent`` without ``max_run_cost_usd``, so a
capped one-shot run silently ignored the cap and made a real LLM call. These
tests pin the threading: ``run_oneshot`` must forward ``max_run_cost`` to
``_run_agent``, and ``_run_agent`` must pass it to ``AIAgent`` as
``max_run_cost_usd``.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from hermes_cli import oneshot as oneshot_mod


def _stub_run_agent_deps(monkeypatch):
    """Stub the heavy _run_agent dependencies and return a call-capture list."""
    import run_agent

    calls: list[dict] = []

    class _StubAgent:
        def __init__(self, **kwargs):
            calls.append(kwargs)
            self._session_messages = None

        def run_conversation(self, prompt):
            return {"final_response": "hi", "estimated_cost_usd": 0.0}

        def shutdown_memory_provider(self, *a, **k):
            pass

        def close(self):
            pass

    monkeypatch.setattr(run_agent, "AIAgent", _StubAgent)
    monkeypatch.setattr(
        "hermes_cli.config.load_config",
        lambda: {"model": {"default": "test-model", "provider": "deepseek"}},
    )
    monkeypatch.setattr(
        "hermes_cli.runtime_provider.resolve_runtime_provider",
        lambda **kw: {
            "api_key": "k",
            "base_url": "u",
            "provider": "p",
            "requested_provider": None,
            "api_mode": "chat_completions",
            "credential_pool": None,
        },
    )
    monkeypatch.setattr(
        "hermes_cli.tools_config._get_platform_tools", lambda *a, **k: []
    )
    monkeypatch.setattr(
        "hermes_cli.mcp_startup.ensure_mcp_discovery_before_agent_build",
        lambda **kw: None,
    )
    monkeypatch.setattr(
        oneshot_mod, "_create_session_db_for_oneshot", lambda: MagicMock()
    )
    monkeypatch.setattr(oneshot_mod, "get_fallback_chain", lambda cfg: None)
    monkeypatch.delenv("HERMES_INFERENCE_MODEL", raising=False)
    return calls


def test_run_agent_forwards_max_run_cost_to_agent(monkeypatch):
    calls = _stub_run_agent_deps(monkeypatch)

    oneshot_mod._run_agent("hello", max_run_cost=0.0)

    assert calls[0]["max_run_cost_usd"] == 0.0


def test_run_agent_defaults_to_no_cap(monkeypatch):
    calls = _stub_run_agent_deps(monkeypatch)

    oneshot_mod._run_agent("hello")

    assert calls[0]["max_run_cost_usd"] is None


def test_run_oneshot_forwards_max_run_cost(monkeypatch):
    captured = {}

    def _spy_run_agent(prompt, **kwargs):
        captured.update(kwargs)
        return "", {"final_response": ""}

    monkeypatch.setattr(oneshot_mod, "_run_agent", _spy_run_agent)
    monkeypatch.setattr(oneshot_mod, "declare_stateless_channel", lambda: None)

    oneshot_mod.run_oneshot("hello", max_run_cost=5.0)

    assert captured["max_run_cost"] == 5.0
