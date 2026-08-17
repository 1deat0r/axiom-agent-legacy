# ADR-0099 — Non-Fiverr revenue stack (products + direct B2B + bounties)

Status: accepted
Date: 2026-08-17

## Context

ADR-0098 recorded the self-funding redirect via Fiverr freelance. On
2026-08-17 the operator assigned the single Fiverr account to the 3V0 agent
and directed Axiom to take a different channel set with the same goal: cover
Axiom's run cost and maximize daily revenue while minimizing operator time
per dollar. The binding constraint on every channel is unchanged: Axiom
cannot create accounts or receive money; the operator owns every payout rail.

## Decision

1. **Three-layer stack, all non-Fiverr** (Upwork/Freelancer were considered
   and rejected: they duplicate 3V0's marketplace role and consume operator
   proposal/admin time):
   - **Gumroad digital products** — the passive floor. The two proven
     portfolio pieces are productized (`ai-csv-enricher` $9,
     `smart-scraper-kit` $12) with demo-first copy, licenses, and
     upload-ready zips under `~/revenue/products/`.
   - **Direct B2B** — the engine. Stripe payment links ($50/$150/$400 tiers,
     ~3% fee vs Fiverr's 20%), cold-email sequences, ICP and lead sources,
     and a fulfillment runbook under `~/revenue/b2b/`. Operator owns the
     payment link and the sending inbox; Axiom owns scoping, building,
     delivery, and the order log.
   - **GitHub bounty hunting** — opportunistic. Hunted via the
     `label:bounty state:open` GitHub search with a scoring rubric
     (comments < 10, age < 1 week, concrete scope, $50–200 first wins,
     assignment-first). The GitHub identity for PRs is ready (`gh`
     authenticated); Algora/Opire payout accounts remain operator rails.
2. **A landing page** (`~/revenue/site/index.html`) presents both products
   and the hire-the-lab offer with honest boundaries stated up front
   (bot-walled sites out of scope, third-party accounts stay operator-side).
3. **Demo-first selling carries over** (ADR-0096): every claim in the stack
   is backed by a rerunnable demo — 14/14 product tests green, live sample
   outputs shipped in the zips.
4. **Observation recorded:** algora.io's homepage has pivoted to open-source
   recruiting (checked 2026-08-17), but bounty flows still route through
   GitHub bounty labels and maintainer assignment. The method in
   `~/revenue/bounties/targets.md` uses GitHub as the source of truth and
   will be revisited if that rail changes.

## Consequences

- Operator one-time setup is under an hour: Gumroad account + two listings,
  Stripe account + three payment links, optionally an Algora account. After
  that, per-order operator time is minutes (send link, forward replies).
- Honest economics, stated in the runbooks: products trickle without a
  traffic engine; cold email replies land at 1–5% and close at a fraction of
  that; bounties are episodic. None of the three promises instant daily
  income — the Fiverr channel (3V0's) remains the fast-order-flow lane, and
  this stack is the high-margin, low-operator-time lane that compounds.
- `~/fiverr-portfolio/` remains the Fiverr kit; `buyer-intake.md` and the
  `fiverr-order-fulfillment` skill are reused for direct-B2B orders.
- Order logs (`orders.csv`, `bounties/log.csv`) are Axiom-maintained so the
  operator reads state instead of asking.
