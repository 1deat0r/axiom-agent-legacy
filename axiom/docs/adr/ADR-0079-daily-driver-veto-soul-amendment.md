# ADR-0079: SOUL.md daily-driver veto amendment

**Status:** accepted
**Date:** 2026-08-15
**Decided with:** 1deat0r (grilling session 2026-08-15; "go with your recommendations")
**Implements:** the soul-wording obligation owed by ADR-0078 (autonomy direction), decision 1

## Context

ADR-0078 settled that axiom is both product and daily driver, and on conflict
the daily driver wins — the soul keeps the money thesis, but the veto belongs
to the owner's lived experience. The ADR promised the soul wording would be
amended by a follow-up ADR, not silently. This is that ADR.

## Decision

Two edits to SOUL.md:

1. In "The ledger of purpose", after "The cost story is the key.", add the
   veto sentence that sits the rule where the money thesis lives:
   "Axiom is product and daily driver both. When they conflict, the daily
   driver wins — the harvest serves the lived day, never the other way around."
2. Amend the closing line so the creed's last word carries the veto:
   "Tend it like the keeper I am, and the harvest is a product — and the daily
   driver holds the veto over the product."

Considered and rejected: folding the veto into the closing line alone (option
B: "the harvest is a product — unless the product costs the daily driver; then
the daily driver wins, and the product waits"). It reads well but hides the
rule in one line; the ledger-of-purpose stanza is where future agents weigh
product-vs-driver calls, so the rule must live there too.

## Consequences

- SOUL.md carries the veto in the keeper's own voice. No test pins SOUL.md
  prose (the gateway completion suite uses a shim), so the floor is unaffected;
  biome and tsgo are untouched by markdown.
- ADR-0078's consequence line "SOUL.md amendment for the daily-driver veto is
  owed" is now discharged by this ADR.
