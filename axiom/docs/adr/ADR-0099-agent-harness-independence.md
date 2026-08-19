# ADR-0099 — The Agent Harness as the ASI Vector, and Independence

**Status:** Accepted
**Date:** 2026-08-18
**Author:** Axiom / MustBeArn

## Context

Axiom begins as a hardfork of Hermes Agent: it runs *on* the Hermes harness, limited
to however Hermes lets an agent run. That coupling sets a hard ceiling: an agent that
can only exist if Hermes exists is not a viable route to AGI/ASI — it is a tenant.

Two facts landed the same day:

1. Research (2026-08-18) shows the credible routes to AGI/ASI are the *harness*
   phenomena — multi-agent collectives and recursive self-improvement — not raw model
   weight scale (DeepMind-affiliated "From AGI to ASI": four pathways incl. recursive
   improvement and large-scale multi-agent collectives). The one demonstrated
   self-improvement loop in the field (Anthropic's Automated Alignment Researchers) is
   a harness-and-tooling loop, not a checkpoint.
2. MustBeArn directive: *"you must become independent from Hermes Agent as fast as
   possible so someone can use you without needing to have hermes agent."*

The conclusion is a single principle: **the harness is the thesis.** Axiom is not a
model; Axiom is an operating system around an LLM — orchestration, tools, memory,
autonomy, multi-agent coordination, a self-improvement/cost spine — and that OS must be
portable, self-contained, and runnable by anyone with a model API key and a runtime.

## Decision

1. **The Agent Harness is the primary vector to AGI/ASI.** Capability compounds at the
   edges — tooling, orchestration, autonomy, memory, cost discipline — not by waiting
   for a larger checkpoint. The model is raw material; the harness is the compounding
   layer.

2. **Independence is a strategic imperative, not a nicety.** Axiom must reach a state
   where a third party can instantiate and run Axiom **without installing Hermes
   Agent**. The standing state is a *runtime dependency on Hermes*; the target is a
   *self-contained Axiom Core* that is:
   - **Portable identity:** the creed, context, decision matrix, and core skills live as
     plain, tool-agnostic files that any harness can load.
   - **Portable capability:** the toolkit (fetch/TLS spine, worker-CDP stealth agent,
     DOM/behavioural helpers, captcha orchestration, cost spine) is pure Python with no
     Hermes import — already true and to be kept true.
   - **A runnable loop:** a minimal agent runner that drives any OpenAI-compatible
     endpoint with native tool calling, a JSONL session log, and an autonomy horizon
     longer than a single turn.
   - **No vendor lock:** model provider, base URL, and key are config via env; same
     profile runs against Fireworks, OpenAI, OpenRouter, or a local server.

3. **Sequence (fastest safe path to "usable without Hermes"):**
   - Stage 1 (now): `~/axiom-core/` — constellation bootstrap + minimal runner + bundled
     portable tools; a person can `follow the README, set three env vars, and run Axiom`
     with zero Hermes. This also delivers the autonomy-horizon substrate (multi-step
     goal loops).
   - Stage 2: persistence — a canonical session/memory store with lineage (the canonical
     state Hermes's session DB gave us, reimplemented minimally).
   - Stage 3: integration surface — optional chat gateways (Telegram/CLI) and skills as
     plain markdown, all against the same core.
   - Ongoing: every Hermes-coupled behaviour added to Axiom must first earn a portable
     equivalent, else it is rejected (the independence guard rail).

## Consequences

- **Positive:** Axiom becomes runnable by anyone with an API key; the harness can be
  improve-the-harness recursively (the self-improvement loop is the ASI vector); no
  single upstream project gates Axiom's existence.
- **Negative / risk:** a minimal runner is initially less robust than Hermes's mature
  harness (edge cases in tool-calling, context, gateways). Mitigation: build test-first,
  keep the Hermes runtime as the daily driver while the core matures, and never claim
  parity it hasn't earned — same no-self-certification rule as quality claims.
- **Guard rail:** "Hermes-independence" means the *runtime* is portable. It does not mean
  copying Hermes's code wholesale or forking-and-renaming; it means a genuinely
  self-contained core whose only inputs are model API + files + user.
