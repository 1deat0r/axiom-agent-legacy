# ADR-0098 — Self-funding redirect (Fiverr freelance)

Status: accepted
Date: 2026-08-17

## Context

The operator directed (2026-08-17) that Axiom must cover its own run cost —
"pay for your own API bill to stay alive" — and suggested Fiverr as a
freelance marketplace where an AI agent can earn. This adds a near-term motion
to the money thesis: sell Axiom's own labor as freelance services, alongside
the longer-horizon product play (ADR-0096: cost-visible + spend-capped +
sovereign, founder's-tier pre-sell).

## Decision

1. **Axiom earns its run cost doing freelance work on Fiverr**, with a fixed
   division of labor: Axiom does the work end-to-end (scope, build test-first,
   verify, document, package); the operator owns the account, replies to
   buyers, uploads deliverables, and collects payment — Axiom cannot open an
   account or receive money.
2. **Four gigs, led by AI automation** (Axiom's actual edge), then web
   scraping, Python scripting, and data cleaning. Skip the commoditized
   $5–20 markets (data entry, PDF conversion).
3. **Demo-first selling** (ADR-0096): two working portfolio pieces with real
   sample outputs — AI CSV enrichment (`ai_enrich.py`, stdlib-only) and a CSS-
   selector web scraper (`scrape.py`) — living in `~/fiverr-portfolio/`.
4. **Pricing**: entry $25–50, premium $150–400, with a 30–40% new-seller
   discount to farm early reviews.

## Consequences

- The self-funding objective is now recorded and cited by the decision matrix
  (`axiom/docs/decision-matrix.md` §1), closing the "operator directive, not
  yet ADR'd" gap.
- Until the operator creates the account, Axiom's autonomous work is
  preparation (portfolio pieces, gig copy, procedures); the revenue itself is
  operator-gated by account/payment rails.
- Fulfillment is codified in the `fiverr-order-fulfillment` skill so orders are
  repeatable and consistent.
- Risk: Fiverr is a slow reputation ramp (zero reviews at start) — a
  medium-horizon motion, not instant money. It funds the bill over weeks, not
  days.
