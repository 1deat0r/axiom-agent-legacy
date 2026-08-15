# ADR-0087 — Re-found Axiom as a Hermes Agent hardfork

Status: accepted
Date: 2026-08-16
Supersedes: ADR-0015 (prime-agent baseline)

## Context

Axiom began as a fork of pi (`archive/pi-v0.84.1`), then re-founded on
prime-agent v0.7.2 (ADR-0015). On 2026-08-16 the operator decided to start
Axiom over as a hardfork of Hermes Agent (NousResearch/hermes-agent) at HEAD,
synthesizing the best architectural decisions from four sources:

- **Hermes Agent** (NousResearch/hermes-agent, MIT, Python + TS UI) — the
  chassis.
- **Prime Agent** (PrimeIntellect-ai/prime-agent, MIT, TypeScript) — the
  previous baseline.
- **DeepSeek Harness** (deepseek-ai/deepseek-harness, MIT, TypeScript) —
  "everything is a plugin" (Cordis).
- **Grok Build** (xai-org/grok-build, Apache-2.0, Rust) — hermetic build and
  provenance discipline.

## Decision

1. Axiom re-founds as a hardfork of Hermes Agent at HEAD
   (`0c50bdbdea57f3d63571e58ae70b3520c4f8b62e`, 2026-08-15), tracked upstream:
   `upstream` remote = NousResearch/hermes-agent, merged routinely.
2. The prime-agent era is archived, not built on: branch and tag
   `archive/prime-v0.7.2` hold the final state (commit `8c7b408de`).
3. Axiom's decision layer — the ADR series (0015–0086), CONTEXT.md, SOUL.md,
   GUIDE.md (the operating guide; the AGENTS.md filename is reserved for an
   operator-approved instruction file), ports.md, and the agent-process docs —
   moves into the top-level `axiom/` directory. The Hermes tree is untouched, so `git merge
   upstream/main` stays clean; Axiom's delta is purely additive.
4. Sovereign capability ships at the edges, per Hermes's footprint ladder:
   extend existing code → CLI command + skill → service-gated tool → plugin →
   MCP server → new core tool (last resort). The Hermes core stays a narrow
   waist; the prompt cache stays sacred.
5. The 3V0 sovereign layer (store-first identity/memory/skills store with
   lineage) ports to TypeScript as a plugin + CLI, byte-compatible with 3V0's
   JSON stores (see axiom/docs/handoff-sovereign-ts.md). This is the primary
   port; Hermes already ships its own memory tool, skills-from-experience,
   subagents, and account billing, so Axiom adds the canonical store and the
   cost ledger — not a second memory system.

## Methodology synthesis (what each source contributes)

- **Hermes (chassis).** The narrow-waist core, the footprint ladder, the
  self-improving loop (skills from experience, curator, memory providers), the
  multi-surface gateway (~20 platforms), subagents + MoA, ACP. Adopted as-is;
  Axiom adds nothing to core that an edge rung can carry.
- **Prime Agent (autonomy + durable state).** RLM — recursive subagents as
  function calls with prompt-as-a-variable — and the Continual Harness —
  durable, evidence-backed refinable state. Hermes already has subagents and a
  learning loop; the harvest is the *evidence-backed refinement discipline*
  and the prompt-as-a-variable framing, not a rewrite.
- **DeepSeek Harness (composability).** Everything is a plugin (Cordis
  spatiotemporal composability). Reinforces Hermes's plugin-first design;
  harvest = keep the sovereign layer as plugins/skills/CLI, never core surface.
- **Grok Build (build discipline + provenance).** Pinned toolchain
  (`rust-toolchain.toml`), `SOURCE_REV` provenance recording the exact upstream
  commit, hermetic reproducible builds. Harvest = record `SOURCE_REV`-style
  provenance in Axiom (this ADR pins the fork point), keep builds reproducible,
  and honor ACP interop (already present in Hermes's `acp_adapter/`).

## Consequences

- `main` is re-rooted on Hermes HEAD. Pushing to origin (1deat0r/axiom-agent)
  requires a force push — operator-gated, not done automatically.
- The prime-era ADRs (0015–0086) remain Axiom's brain and the spec for the
  ports; they describe Axiom's decisions, not prime-agent's code.
- Remotes: `upstream` = NousResearch/hermes-agent (track), `prime-agent` =
  PrimeIntellect-ai/prime-agent (reference), `upstream-pi` = earendil-works/pi
  (reference), `origin` = 1deat0r/axiom-agent.
- The initial fetch was shallow (`--depth=1`). Run `git fetch --unshallow
  upstream` before the first upstream merge.
- The ADR series continues (this is 0087). Axiom-owned durable state stays in
  `AXIOM_HOME` (`~/.axiom`), independent of the baseline, per the ADR-0015
  data-cutover rule.
