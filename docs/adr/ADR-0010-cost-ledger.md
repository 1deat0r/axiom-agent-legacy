# Cost ledger: price every run, cap runaway spend

ADR-0010 records the decision to make spend a first-class, visible quantity
in the core: the agent loop prices every run's token usage, accumulates it
into the session, and can stop a run before it spends past a configured cap.
This ADR documents the chosen strategy and the alternatives weighed.

## Decisions

- **The cost ledger is a pure function over usage.** `costOf(usage, model,
  rates?)` prices a `ChatResult`'s recorded tokens; `ratesFor(model, entry?)`
  resolves the rate: a `providers.json` entry's explicit
  `pricePer1kIn`/`pricePer1kOut` wins, then the catalog price table
  (`CATALOG_RATES`, same 2026-08-11 snapshot as ADR-0009), then
  `DEFAULT_RATES` ($0.25 in / $1.00 out per 1M — the low end of hosted-LLM
  pricing). Every number is USD per 1,000 tokens.
- **The ledger never invents spend.** Providers that report no usage price to
  zero; unknown models fall back to the default rate and the figure is
  honest about being an estimate (surfaces render it as spend, not billing).
  Prices are data — they drift with vendor pricing, and a `providers.json`
  entry override updates them without code changes.
- **The run result carries `costUsd`; the session accumulates it.** The
  agent sums each turn's priced usage into the run's `costUsd` — on the
  returned `ChatResult` and the `end` event, present when the run recorded
  usage (usage-less runs omit it; the ledger never invents spend) — and,
  when > 0, into `session.meta` via the existing meta channel, so `/cost`
  shows the active session's spend and lifetime spend across all sessions,
  restart-surviving.
- **`maxRunCostUsd` is a hard pre-call guard, not a post-hoc report.** The
  loop checks the run's recorded spend BEFORE each LLM call and ends with
  `finishReason: 'cost_limit'` once the cap is reached — a runaway agent
  cannot spend past the cap, it can only land up to one turn over it.
  `0` disables LLM calls entirely. The guard counts recorded usage only:
  a provider that never reports usage cannot trip it.
- **Surfaces set rates from the active provider entry.** The CLI calls
  `agent.setCostRates(ratesFor(entry.model, entry))` on `/use` so the
  ledger follows provider switches; the initial provider uses the table by
  model id.

## Alternatives considered (and rejected)

- **Server-side billing dashboards / API usage endpoints.** Requires vendor
  accounts and tokens, couples the ledger to network availability, and is
  per-vendor — the point of the ledger is to work uniformly across the
  catalog with data the loop already receives.
- **Estimating usage for providers that report none.** The loop has no
  tokenizer; a guessed number would be worse than none — it would silently
  mislead the spend cap in both directions.
- **A hard pre-turn budget check against the *projected* next-turn cost.**
  Projection needs a tokenizer or a heuristic on message length; the
  recorded-usage check is deterministic, testable, and the one-turn
  overshoot is bounded by the cap itself.
- **Per-session persistent cost in a separate store.** Session `meta`
  already persists through the existing store interface and survives
  restarts; a second store would split one concept across two files.
