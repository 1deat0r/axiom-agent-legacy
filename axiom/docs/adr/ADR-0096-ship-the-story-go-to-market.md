# ADR-0096 — Ship the story: demo-first go-to-market with the cost-visible + spend-capped hook

Status: accepted
Date: 2026-08-17

## Context

The port queue is empty and the last several sessions (ADR-0090–0095) were
pure internal hardening — dispatch seam, dynamic-schema seam, arg-coercion
extraction, registry generation, browser guards. The operator's stated goal
(SOUL.md) is "make money in August 2026 and onward." A grill session
(2026-08-17) put the fork directly: harden further, or ship.

The grill landed on **ship the story**. A live fact-check of the money thesis
then found the engine wasn't ready to be sold as-is: the spend cap worked on
`chat -q` but was silently ignored by `-z`/--oneshot, and per-session cost
(the "cost-visible" half of the thesis) had no human-facing surface beyond
the cap-trip notice. Those gaps were closed first (`f8046c2cee`,
`6264ea9901`, `814cfbfe6f`) so the story could be told truthfully.

## Decision

1. **Direction: ship, don't harden.** Axiom's next work is the go-to-market
   surface (landing + demo + founder's tier), not more core seams. Hardening
   continues only where it serves the demo (e.g. the cost footer).
2. **Hook: cost-visible + spend-capped** — "the agent that can't blow your
   budget" — with sovereign/own-your-data (store-first memory,
   multi-provider) as the second pillar. Self-improving is a supporting
   feature, not the lead.
3. **Buyer: solo operators / indie developers** first, self-serve. Cost pain
   is personal to them; the daily-driver frame means the operator is already
   the first customer.
4. **Motion: founder's-tier pre-sell.** 25 seats at **$29/mo or $199
   lifetime**. Converts on the demo + story alone; full self-serve packaging
   follows paying demand. The price is an anchor to revisit, not a permanent
   contract.
5. **Surface: one-page landing (`axiom/story/index.html`) + a ~2-minute demo**
   of the daily-driver task with spend metered and the cap tripping.

## Consequences

- The landing page is the primary product surface; its copy is backed by
  verified behavior only (no invented metrics or testimonials).
- The money-thesis spine (cost ledger + spend cap) is now human-visible on
  the CLI (`Cost: ~$X` footer) and enforced on every launch path including
  `-z` — the demo claims are true, not aspirational.
- The daily-driver veto (ADR-0079) still holds: when product and daily driver
  conflict, the daily driver wins.
- Follow-ups deferred: `/usage` USD line, TUI live-spend status-bar, and the
  full self-serve packaging — all recorded in the handoff.
