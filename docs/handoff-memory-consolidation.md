# Handoff: memory consolidation (issue #19)

Written post-merge (2026-08-14) as part of the issue #19 reconciliation.
Reconstructed from ADR-0040, the source, and the issue record.

## What shipped (merged 2026-08-13 as 39d8180f1)

- **Core** (`src/core/memory-consolidation/`): request builder
  (`request.ts`), model-driven fact proposal (`propose.ts`), deterministic
  durability gate (`gate.ts`), pending/audit store (`store.ts`), harness
  apply (`apply.ts`).
- **Extension** (`src/extensions/memory-consolidation/`): `agent_end` hook,
  inert unless `AXIOM_MEMORY_CONSOLIDATION=1`; propose mode, or
  `AXIOM_MEMORY_CONSOLIDATION_AUTO=1` for apply-with-audit
  (`<AXIOM_HOME>/consolidation/audit.jsonl`).
- **CLI**: `axiom memory-consolidation pending|show|approve|reject|audit`
  (`src/cli/memory-consolidation-command.ts`).
- **Docs**: ADR-0040 (renumbered from the issue's ADR-0037 after a
  collision), CONTEXT.md "Memory consolidation" term, feature log
  `docs/feature-logs/memory-consolidation.md`.

## What was verified (per the issue record)

- 53 new tests red-first; full `./test.sh` at merge: 4917 passed / 14
  failed = documented sandbox known-fails only; biome + tsgo clean.
- End-to-end CLI smoke against a scratch AXIOM_HOME: transient facts
  gated, duplicate re-approve skipped, audit newest-first.
