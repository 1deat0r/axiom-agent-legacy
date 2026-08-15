# ADR-0076: Autonomy direction — silent-by-default learning on a Hermes ownership lattice

**Status:** accepted
**Date:** 2026-08-15
**Decided with:** 1deat0r (the owner), grilling session 2026-08-15
**Supersedes:** ADR-0040's staging-by-default posture; ADR-0027's inert-by-default posture for the consolidation hook
**Note on ceremony:** written under the restructure execution rules (ceremony override) — ADR recorded directly without issue reservation, per the directive that paperwork must not block the restructure.

## Context

The owner used Hermes Agent and Prime Agent side by side and made a decision: axiom keeps the prime lineage (TypeScript host, lean per turn, typed discipline, compact prompts) but adopts Hermes's *feel* — quiet accretion, reach, no ceremony. A full grilling decomposed the preference and settled every branch of the design tree before this ADR.

## Decision

1. **Identity.** Axiom is both product and daily driver; when they conflict, the **daily driver wins**. This amends SOUL.md's "the harvest is a product" — the soul keeps the money thesis, but the veto belongs to the owner's lived experience. (Soul wording will be amended in a follow-up ADR, not silently.)

2. **Guardrails — Hermes ownership lattice, not fully-agent-owned.** The loop writes silently *only what it owns*: curator-managed skills and its own memories. Bundled, pinned, and user-owned work is protected. The learning actor runs with a whitelisted toolset; hard bounds are code-enforced. Fully-agent-owned safety was considered and rejected. **The floor autonomy can never touch: SOUL.md, the test suite, the ledger's never-guess rule, and the append-only witness log.**

3. **Effect timing — split.** Memory and skill entries freeze into a session-start snapshot (cache-sacred, felt next session). Prompt notes — small behavioral corrections — apply immediately. Only prompt-note refinements rebuild the live prompt.

4. **Confirmation — silent by default.** Auto-apply is the default. Every write lands in the append-only audit log the loop cannot rewrite; rollback stays available through the refinement history. `--confirm`/staging remains as opt-in (`AXIOM_MEMORY_CONSOLIDATION_AUTO=0`). This flips ADR-0040's default and is the first concrete change (this ADR ships with it).

5. **Prompt depth dial.** Summaries by default; switchable levels: Full summary → Summarized → Half-Summary → Text → Full Text. Cheap per turn is a default posture, never a ceiling.

6. **Shape.** Axiom stays majority TypeScript, leaning into Hermes-style features rather than away from the host.

7. **Port order.** `/learn` → session recall → gateway channels → cron → dashboard.

## Execution rules (until the restructure lands on main)

- Process ceremony overridden: no readiness-contract blocking; ADRs and handoffs batch at milestones.
- Quality gates relaxed: WIP branches may carry red tests; `./test.sh`, biome, and tsgo must hold before anything reaches main.
- Runtime safety intact: spend cap, cost ledger, root guard, security fence, and durability gates are NOT overridden. The cap is raised explicitly if needed, never removed.

## Consequences

- `AXIOM_MEMORY_CONSOLIDATION` and `AXIOM_MEMORY_CONSOLIDATION_AUTO` default to enabled+auto; opt-out is `=0`. Pinned by new tests in `packages/coding-agent/test/extensions/memory-consolidation.test.ts`.
- The ownership lattice (pin/protected/curator-managed) is the next core capability after `/learn`.
- SOUL.md amendment for the daily-driver veto is owed; a follow-up ADR will word it.
