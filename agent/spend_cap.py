"""Run-level spend cap (ADR-0011): the hard pre-call guard.

The cost ledger (ADR-0010) accumulates ``session_estimated_cost_usd`` from
recorded usage only — a provider that reports no usage prices to zero and
can never trip the cap. The cap (``max_run_cost_usd``) is a launch property:
``None`` means no cap, ``0`` disables LLM calls entirely, and any other
value stops the loop before the next LLM call once recorded spend reaches
it (``cost_limit`` exit reason).

Kept as a tiny pure module so the guard decision is unit-testable without
importing the conversation loop.
"""

from __future__ import annotations

from typing import Any


def spend_cap_exceeded(agent: Any) -> bool:
    """True when the run's recorded spend has reached its cap.

    Recorded usage only: ``session_estimated_cost_usd`` grows solely from
    provider-reported usage priced by the ledger. ``max_run_cost_usd=None``
    (or missing) means no cap; ``0`` trips on the very first check because
    ``0.0 >= 0.0``.
    """
    cap = getattr(agent, "max_run_cost_usd", None)
    if cap is None:
        return False
    return agent.session_estimated_cost_usd >= cap
