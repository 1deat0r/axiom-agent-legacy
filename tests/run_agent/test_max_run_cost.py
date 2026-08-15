"""Spend-cap guard tests (port #5, ADR-0011, issue #65).

The cost ledger (ADR-0010) accumulates ``session_estimated_cost_usd`` from
recorded usage only. The cap (``max_run_cost_usd``) is a hard pre-call
guard: once recorded spend reaches the ceiling the loop stops before the
next LLM call with a ``cost_limit`` exit reason.

Semantics under test:
- ``None`` = no cap (never trips).
- ``0`` disables LLM calls entirely (trips before the first call).
- A provider that reports no usage prices to zero and can never trip a
  positive cap.
- A ``cost_limit`` stop must NOT burn another LLM call on a summary.
"""

import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from agent.spend_cap import spend_cap_exceeded
from agent.turn_finalizer import finalize_turn


class _CapAgent:
    """Minimal double for the pure guard's two inputs."""

    def __init__(self, *, cost=0.0, cap=None):
        self.session_estimated_cost_usd = cost
        self.max_run_cost_usd = cap


# ── The pure guard ───────────────────────────────────────────────────────


def test_no_cap_never_trips():
    assert spend_cap_exceeded(_CapAgent(cost=999.0, cap=None)) is False


def test_cap_zero_trips_before_the_first_call():
    # 0 disables LLM calls entirely: 0.0 >= 0.0 trips on iteration one.
    assert spend_cap_exceeded(_CapAgent(cost=0.0, cap=0.0)) is True


def test_below_cap_does_not_trip():
    assert spend_cap_exceeded(_CapAgent(cost=4.99, cap=5.0)) is False


def test_at_or_above_cap_trips():
    assert spend_cap_exceeded(_CapAgent(cost=5.0, cap=5.0)) is True
    assert spend_cap_exceeded(_CapAgent(cost=5.01, cap=5.0)) is True


def test_no_usage_provider_never_trips():
    # Recorded usage only: cost stays 0.0 against a positive cap -> no trip.
    assert spend_cap_exceeded(_CapAgent(cost=0.0, cap=5.0)) is False


def test_missing_cap_attribute_defaults_to_no_cap():
    agent = _CapAgent(cost=100.0)
    del agent.max_run_cost_usd
    assert spend_cap_exceeded(agent) is False


# ── The finalizer: cost_limit must not trigger a summary call ────────────


class _FinalizeAgent:
    def __init__(self):
        self.max_iterations = 60
        self.iteration_budget = types.SimpleNamespace(
            remaining=60, used=0, max_total=60
        )
        self.quiet_mode = True
        self.model = "test-model"
        self.provider = "test-provider"
        self.base_url = ""
        self.session_id = "sess-cap"
        self.context_compressor = types.SimpleNamespace(last_prompt_tokens=0)
        self.session_input_tokens = 0
        self.session_output_tokens = 0
        self.session_cache_read_tokens = 0
        self.session_cache_write_tokens = 0
        self.session_reasoning_tokens = 0
        self.session_prompt_tokens = 0
        self.session_completion_tokens = 0
        self.session_total_tokens = 0
        self.session_estimated_cost_usd = 0.0
        self.session_cost_status = "unknown"
        self.session_cost_source = "test"
        self._tool_guardrail_halt_decision = None
        self._interrupt_message = None
        self._response_was_previewed = False
        self._skill_nudge_interval = 0
        self._iters_since_skill = 0
        self.valid_tool_names = []
        self.persisted_messages = None
        self._handle_max_iterations_called = False

    def _handle_max_iterations(self, messages, api_call_count):
        self._handle_max_iterations_called = True
        return "summary from extra call"

    def _emit_status(self, *_args, **_kwargs):
        pass

    def _safe_print(self, *_args, **_kwargs):
        pass

    def _save_trajectory(self, *_args, **_kwargs):
        pass

    def _cleanup_task_resources(self, *_args, **_kwargs):
        pass

    def _drop_trailing_empty_response_scaffolding(self, messages):
        pass

    def _persist_session(self, messages, conversation_history):
        self.persisted_messages = list(messages)

    def _file_mutation_verifier_enabled(self):
        return False

    def _turn_completion_explainer_enabled(self):
        return True

    def _format_turn_completion_explanation(self, _reason, *_args):
        return "cap explanation"

    def _drain_pending_steer(self):
        return None

    def clear_interrupt(self):
        pass

    def _sync_external_memory_for_turn(self, **_kwargs):
        pass


def test_cost_limit_exit_makes_no_summary_call(monkeypatch):
    monkeypatch.setattr("hermes_cli.plugins.invoke_hook", lambda *_a, **_kw: [])
    agent = _FinalizeAgent()

    result = finalize_turn(
        agent,
        final_response="Spend cap reached.",
        api_call_count=3,
        interrupted=False,
        failed=False,
        messages=[{"role": "user", "content": "task"}],
        conversation_history=[],
        effective_task_id="task",
        turn_id="turn",
        user_message="task",
        original_user_message="task",
        _should_review_memory=False,
        _turn_exit_reason="cost_limit",
    )

    assert result["turn_exit_reason"] == "cost_limit"
    assert result["completed"] is False
    # A cost-limit stop must NOT burn another LLM call on a summary.
    assert agent._handle_max_iterations_called is False


# ── The loop: cap=0 issues zero LLM calls ────────────────────────────────


class _LoopAgent(_FinalizeAgent):
    """A _FinalizeAgent plus the attributes the loop touches before the guard."""

    def __init__(self, *, cap=0.0):
        super().__init__()
        self.api_mode = "chat_completions"
        self.max_run_cost_usd = cap
        self._budget_grace_call = False
        self._interrupt_requested = False
        self._background_review_agent = None
        self._checkpoint_mgr = types.SimpleNamespace(new_turn=lambda: None)

    def _try_refresh_env_client_credentials(self):
        pass

    def _drain_pending_redirect(self):
        return None


def test_cap_zero_makes_no_llm_call(monkeypatch):
    monkeypatch.setattr("hermes_cli.plugins.invoke_hook", lambda *_a, **_kw: [])

    from agent import conversation_loop

    _ctx = types.SimpleNamespace(
        user_message="hi",
        original_user_message="hi",
        messages=[{"role": "user", "content": "hi"}],
        conversation_history=[],
        active_system_prompt=None,
        effective_task_id="task",
        turn_id="turn",
        current_turn_user_idx=0,
        should_review_memory=False,
        plugin_user_context=None,
        ext_prefetch_cache=None,
        preflight_compression_blocked=False,
    )
    monkeypatch.setattr(conversation_loop, "build_turn_context", lambda *a, **k: _ctx)

    agent = _LoopAgent(cap=0.0)

    result = conversation_loop.run_conversation(agent, "hi")

    assert result["turn_exit_reason"] == "cost_limit"
    assert result["api_calls"] == 0
    assert result["completed"] is False
    # The cap notice is delivered instead of any model output.
    assert "Spend cap reached" in (result["final_response"] or "")

