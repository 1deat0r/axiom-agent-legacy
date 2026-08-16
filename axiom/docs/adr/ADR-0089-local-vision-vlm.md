# ADR-0089 — Axiom vision on a local VLM (Qwen2.5-VL via Ollama), not cloud

Status: accepted
Date: 2026-08-16

## Context

Axiom's main provider is DeepSeek (`deepseek-v4-pro`, with `-flash` as the
cheap tier) — text-only, no vision model. Before this decision a
`vision_analyze` call could not resolve a useful vision backend from the main
provider and would fall through to a paid aggregator. The money thesis
(CONTEXT.md) wants the agent cost-visible, multi-provider, and demonstrable on
real surfaces; local hardware is available (RTX 5070, 12 GB VRAM).
Qwen2.5-VL-7B at Q4_K_M is ~6 GB — it fits with headroom and covers
screenshots, UI, diagrams, OCR, and documents at zero per-call cost.

## Decision

1. **Route vision to a local VLM.** `auxiliary.vision` is pinned to
   `provider: custom`, `model: qwen2.5vl:7b`,
   `base_url: http://localhost:11434/v1` (Ollama), with a placeholder
   `api_key` (local servers ignore auth). Pinned explicitly, not `auto`, so
   vision never reaches a paid cloud provider and is decoupled from the main
   model. Verified: `deepseek-v4-flash`, `deepseek-v4-pro`, and no main-model
   binding all resolve vision to the local endpoint.
2. **Local model is vision-only.** The agent's text brain stays on the main
   provider. A 7B text model is a capability downgrade for the agent loop;
   there is no local main model.
3. **Fail loud, not silently paid.** Vision is pinned local, so an Ollama
   outage surfaces as an error instead of a silent fallback to a cloud vision
   model — no hidden spend.

## Consequences

- Vision is zero marginal cost and sovereign; the cost ledger (ADR-0010) and
  spend cap (ADR-0011) both exclude local vision entirely.
- VRAM: ~6 GB while loaded; Ollama auto-unloads after ~5 min idle, so it does
  not hold VRAM when unused. The daemon is a system service
  (`/var/lib/ollama`), so the model persists across sessions and reboots.
- Local OCR at Q4_K_M is strong for normal screenshots/UI/documents but
  weaker than a cloud VLM on very small or dense text — the accepted trade
  for 6 GB local.
- Runtime is Ollama rather than raw `llama-server` because it was already
  installed, auto-builds CUDA for the Blackwell card, and bundles the vision
  projector — the smallest-footprint path that meets the need.
