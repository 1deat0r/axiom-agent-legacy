
> Numbering note: originally written as ADR-0052; renumbered to ADR-0055
> at merge time because feat/root-guard claimed 0052 and ADR-0054 was taken by
> the delegate Ralph handoff (issue #33). Recorded 2026-08-14.

# ADR-0055: Gateway session token meter (measure the model-facing surface, trigger compaction on token pressure)

**Status:** accepted
**Date:** 2026-08-14
**Extends:** ADR-0001 (gateway), ADR-0041 (session budget)
**Follows up:** ADR-0051 (gateway completion resilience)

## Context

ADR-0041 bounds a channel session by file bytes: past
`GATEWAY_SESSION_BUDGET_BYTES` (256KB of JSONL) the gateway flags the run
`compactBefore`, so the completion child summarizes the context instead of
re-processing it whole. The bound fixed the 2026-08-13 incident (a 2.6MB
session = ~508k real tokens, minute-scale replies), but bytes are a weak
proxy for the thing that actually costs: the model-facing surface. A
metadata-heavy file (timestamps, ids, git state, status entries) can blow
the byte budget while the model-facing surface stays small, and a
content-heavy file can hold tens of thousands of tokens while still under
the byte cap. The byte check also cannot answer "how much surface is there
really" - it can only say whether the file is big. The deepseek-harness
knowledge graph points at the proven shape for this: a token meter with
detached, immutable, revisioned measurements and a fixed-density heuristic
estimator, consumed by the compaction trigger.

## Decision

A token meter in the gateway (`src/gateway/session-token-meter.ts`) that
prices the model-facing surface of the channel session and becomes the
primary compaction trigger:

- **Deterministic estimator, no tokenizer.** Fixed text density of one
  heuristic token per 4 characters (`CHARS_PER_TOKEN`), plus structural
  overhead per content block (`BLOCK_OVERHEAD`, 4) and per message role
  (`ROLE_OVERHEAD`, 4). Text and thinking blocks price by length; toolCall
  blocks price name + stringified arguments; toolResult messages price
  nested content plus the tool name; unknown block types fall back to a
  conservative JSON price so a new provider shape can never read as free
  surface. The same numbers are reproducible from any session file, so the
  meter is deterministic by construction.
- **The surface is the message entries.** `measureSessionTokens(path)`
  reads the session JSONL once and prices every `message` entry (the
  user/assistant/toolResult turns the model actually sees); session
  metadata entries (model changes, git state, status) are not model-facing
  and price nothing. The system prompt envelope is not visible to the
  gateway and stays unpriced (recorded follow-up).
- **Immutable revisioned snapshots.** The returned `TokenMeterSnapshot` is
  frozen and carries `revision` (JSONL entries consumed), the estimator
  identity and density, `surfaceTokens`, `pricedMessages`, and
  `malformedEntries`. Unparseable lines are skipped and counted - a bad
  line can never block a measurement, and the revision still advances so
  the snapshot stays an honest "as of entry N" statement. Missing or
  unreadable files measure as a zero snapshot, so the check can never block
  a reply.
- **Token pressure triggers compaction.** `GATEWAY_SESSION_TOKEN_BUDGET`
  (48 * 1024 heuristic tokens) is the soft cap; the gateway flags the run
  `compactBefore` when `sessionExceedsTokenBudget(path)` holds. The byte
  budget stays wired as an OR backstop (`sessionExceedsBudget`), so a
  metadata-heavy file the heuristic prices low still compacts - the byte
  check is now the safety limit, not the primary trigger.
- **Pure predicate.** `exceedsTokenBudget(snapshot, budget)` is a pure
  function over a snapshot, so the trigger logic is testable without a
  file system, and the file-reading convenience
  `sessionExceedsTokenBudget(path, budget?)` mirrors `sessionExceedsBudget`'s
  never-block contract.

## Consequences

- Compaction now fires on what actually costs - the model-facing surface -
  not on file bytes; a token-heavy session under the byte budget compacts,
  and a metadata-heavy session still compacts through the byte backstop.
- The meter is an estimate: 4 chars/token overcounts code-heavy surfaces
  for some tokenizers and undercounts for others. The budget is a pressure
  heuristic, not a prefill oracle; the byte budget covers the undercount
  side, and a provider tokenizer is the recorded follow-up for exactness.
- Every reply now reads and parses the session JSONL once (bounded in
  practice by the byte budget); this is the same O(file) cost class the
  completion child already pays, but the gateway pays it per message where
  it used to stat only. Incremental sync (resume from `revision`) is the
  recorded follow-up if this ever shows in profiles.
- The byte budget constant and its archive behavior are unchanged; no
  /search index changes, no compaction-summary changes, no billing changes.
