# Memory eviction: bounded per-scope LRU, applied on add

ADR-0008 records the decision for ticket #8: the memory store grows without
bound and had no removal policy beyond explicit tool-driven removes. The owner
authorized this decision autonomously; this ADR documents the chosen strategy
and the alternatives weighed and rejected.

## Decisions

- **Eviction policy: max-entries LRU, capped per scope, applied on `add`.**
  Each memory scope (`user`, `agent`) gets an optional entry cap. When an
  `add` pushes a scope past its cap, the least-recently-**updated** entries
  (the tail of the store's existing `updatedAt`-descending order) are removed
  until the scope is back at the cap. The surviving set is therefore exactly
  the most recently touched facts — the ones most likely to be live, durable
  context.
- **Opt-in via constructor config.** The store implementations gain an optional
  `maxEntriesPerScope?: number`. When unset (default) the store is unbounded,
  preserving today's behaviour exactly; existing callers and tests are
  untouched. Callers that want bounded memory pass a cap.
- **Eviction lives inside the stores, not the tool.** The `memory` tool and
  agent loop are unchanged. This keeps the policy co-located with the data
  (it must run on `add` regardless of the surface that called it) and the
  interface (`MemoryStore`) stable.
- **A scope's cap applies to that scope only.** `user` and `agent` facts are
  independent pools, so a flood of agent-generated notes cannot evict the
  user's durable preferences, and vice-versa. This is the defensible default
  for a two-scope design.

## Alternatives considered (and rejected)

- **TTL / age-based expiry.** Evicting on a wall-clock timer risks silently
  dropping facts that are old but still true and load-bearing (e.g. "user is on
  CachyOS"). Memory semantics are *durable facts*, so recency-of-*use* (LRU)
  is a better signal than recency-of-*creation* (age). TTL also adds a clock
  dependency that makes the store non-deterministic to test.
- **Agent-decides eviction.** Letting the model choose what to forget via the
  tool adds an LLM round-trip, latency, and non-determinism on every insert;
  it also can't be relied on (the model may never call it). A host-enforced
  cap is deterministic and always runs.
- **Cross-scope global cap.** A single shared cap would let one scope starve
  the other; per-scope is simpler to reason about and matches how the two
  scopes are injected separately into context.
- **Evict on `list` / on read.** Deferring eviction to read time makes the
  store's on-disk state diverge from what reads report and complicates
  persistence. Doing it eagerly on `add` keeps the file in a bounded, valid
  state at every write.

## Status

accepted

## Consequences

- Bounded stores never grow past the cap: the JSON files stay small and the
  injected memory context block stays proportionally bounded, which bounds the
  cost/latency contribution of memory to every turn.
- Eviction is destructive: dropped entries are gone (consistent with the
  existing `remove` semantics). A caller that needs higher retention raises
  the cap.
- LRU ordering already drives `list()` (newest-updated first), so no new
  ordering logic is introduced — eviction simply enforces the cap on the same
  axis `list()` presents.
