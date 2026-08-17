# ADR-0097 — Re-surface cost-visible (exit footer + /usage + TUI status bar), gated on known pricing

Status: accepted
Date: 2026-08-17

## Context

Upstream Hermes deliberately removed cost + cache-hit reporting from every
user-facing surface in `fd2a35b169` (#52717). The reason was reliability, not
taste: per-call cost estimates were wrong on providers that don't surface
`prompt_tokens_details.cached_tokens` (e.g. ollama-cloud), producing
misleading near-zero "cache hit" readouts and cost figures. The commit kept
provider-agnostic token counts and the Nous account-billing UI, and left
`estimate_usage_cost` / `format_cost` intact, marking the removal
"display-only, reversible".

Axiom's product thesis (ADR-0096, ADR-0010/0011) is *cost-visible +
spend-capped*. Session 13 shipped the CLI exit footer (`Cost: ~$X`,
`6264ea9901`) and the `/usage` "Estimated cost" line. This session adds the
live TUI status-bar segment — the third surface, so a demo viewer watching the
agent work sees the spend tick up in real time, not only after the fact.

## Decision

1. **Re-surface cost-visible on the CLI and TUI** — the exit footer, the
   `/usage` panel, and the live TUI status bar — as a deliberate divergence
   from upstream #52717.
2. **Gate the display on known pricing.** `format_session_cost` returns `None`
   (no line) when `session_cost_status == "unknown"` or the accumulator is
   `None`, so a provider that can't be priced honestly shows *nothing* rather
   than a misleading near-zero. This is the fix #52717's removal was a
   workaround for, made explicit.
3. **Keep the legacy cost fields and cache-hit readouts removed.** "Total
   cost:", "Cost status:", "Cost source:", and cache read/write token lines
   stay gone everywhere — only the new, honest "Estimated cost" line returns.
4. **One formatter, three surfaces.** The TUI bar renders
   `format_session_cost`'s label verbatim via `usage.session_cost_label`
   (computed in `tui_gateway/server.py::_get_usage`, gated on the same `None`
   return). No money math happens in the TypeScript layer, so the exit footer,
   `/usage`, and status bar stay byte-identical and sub-cent honesty can't
   regress on any one surface.

## Consequences

- The "cost-visible" half of the money thesis is now true on the surfaces a
  demo viewer sees: the exit footer, `/usage`, and the live TUI status bar.
- The divergence is display-only and reversible; it does not touch
  `estimate_usage_cost` or the pricing tables, so the upstream merge stays
  clean.
- The TUI's pre-existing `dev_credits_spent_micros` (Nous-portal credits,
  `HERMES_DEV_CREDITS`-gated) is unchanged and orthogonal: it tracks account
  credit balance, not token-estimated spend.
- If upstream later re-surfaces its own cost display, Axiom's line must be
  reconciled with it (single source of truth) rather than stacked.
