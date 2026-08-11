# Round-1 synthetic-user acceptance — profiles + ledger + cap + memory

Five unique personas drove the shipped axiom surface through the real
extension defaults (real fs, real env, real file layout). Journeys:
`packages/coding-agent/test/acceptance/personas-round1.test.ts` (all green).

## Persona reviews

### Mira (solo indie dev) — client work
"Created a `client-alpha` profile and ran a full loop: SOUL.md showed up in
the prompt, `/cost` on a fresh session said $0.0000, I saved a fact about
the client and it rode into the next run, I set a $0.50 run cap and the run
stopped mid-flight with 'cost cap $0.50 reached' — then `/cost` showed the
$0.60 I'd spent. That all works and I trust the numbers. Two things annoyed
me: to set the cap I had to hand-edit JSON, which feels wrong for something
I'll change every week, and when the cap hit I got no hint what to do next.
I stared at the toast for a second before I remembered the file."

### Tom (curious beginner) — first agent
"`profile list` on an empty home said 'No profiles yet — create one…' which
was friendly. Creating `my-bot` worked and I could read my identity block in
the prompt. The memory block was readable too — I could see '[user] Tom
prefers plain English' sitting there. But after creating the profile nobody
told me I still needed to connect a provider — I just assumed it would
work, and it wouldn't have. The 'LLM calls disabled' message when I set cap
0 was clear enough, but again, no pointer to what to do."

### Priya (budget-watcher) — cost control
"I priced my model with an override and watched the ledger reprice a
$9.00-recorded run to $0.50 everywhere: footer, /cost, and the cap all
agreed. That consistency is exactly what I need. But I am not a developer —
editing `ledger.json` to change the cap is the part I hate. I need a
command. And nothing ever shows me the current cap; I have to remember
what I set."

### Dana (team lead) — parallel profiles
"Isolation is real: `research` and `writing` profiles share nothing — the
writing agent's prompt had zero memory of research, and its ledger file
didn't even exist yet. That's the whole point for me. One gap: when I'm
inside a session I can't tell which profile I'm in without checking the
prompt. The header/footer should say it."

### Kai (power user) — limits and detail
"I flooded 55 facts into memory and got 50 back — the cap held and the
newest survived. But nothing TOLD me five facts had been evicted. I only
noticed because I counted. Silent data loss is the one thing I can't
audit. And `/cost` with two models gave me one total — I want to see the
per-model rows without opening a file."

## Synthesis — the five findings

| # | Finding | Who felt it | Severity |
|---|---|---|---|
| 1 | No command surface for the cap: set/show/clear requires hand-editing `ledger.json` | Priya, Mira | high |
| 2 | Memory eviction is silent: facts vanish with no notice, no audit | Kai, Tom | high |
| 3 | `/cost` is a single-line total: no per-model breakdown, no cap shown | Mira, Kai | medium |
| 4 | Cap-stop gives no next steps ("run stopped" — then what?) | Mira, Tom | medium |
| 5 | Fresh profile has no provider hint; active profile not visible at a glance | Tom, Dana | medium |

## Revision plan (v2 — revised per independent expert review)

Expert verdict: DENY (v1) → required changes incorporated. The reviewer
verified every fix against the code; all five fixes' direction held, six
specifics were required. v2 changes are marked.

- **Fix 1 — `/cap` command (ledger extension):** `/cap` shows the current
  cap **plus current session and lifetime spend (headroom)**; `/cap <usd>`
  sets it; `/cap none` clears it; **`/cap 0` disables LLM calls**. Writes
  via a new `writeLedgerConfig` helper that **preserves overrides and writes
  atomically** (tmp + rename, the FileMemoryStore discipline). **Validation:
  finite non-negative number, `0`, or `none` — negatives and garbage are
  rejected with an error** (`shouldBlockRun` treats any `<= 0` as disable,
  so `/cap -1` must not silently disable).
- **Fix 2 — eviction visibility (memory store, per expert):** the eviction
  count is sourced from the **store, not the extension** — `MemoryStore.add`
  gains the evicted count from that add (both FileMemoryStore and
  InMemoryMemoryStore change together; memory.test.ts red-first). The `add`
  result text reports it ("…evicted N stale entries under the cap") so
  Kai's flood reports each per-add eviction.
- **Fix 3 — `/cost` detail (per expert):** the report gains per-model rows
  for the top buckets **with an explicit "+N more models" overflow note**
  (no silent truncation), and the cap line **renders only when a cap is
  set**. `buildCostReport` keeps its 3-arg signature; new info arrives via
  **additive optional params** (existing direct tests stay green or are
  updated deliberately).
- **Fix 4 — cap-stop next steps (both toasts, per expert):** the "reached"
  toast appends "run /cost to review, /cap to adjust"; the **zero-cap toast
  appends "run /cap none to re-enable"** (lands with Fix 1 in the same
  change).
- **Fix 5a — profile onboarding hint:** `profile create` prints "run
  --profile <name>, then /login to connect a provider".
- **Fix 5b — active-profile visibility (NEW, per expert):** the profile
  extension sets a footer status (`axiom.profile`) at agent_start — the
  same pattern as the ledger's `axiom.cost` — so Dana can tell which
  profile a session is in at a glance.

**Named regressions (red-first, in the same changes):**
- Kai's round-1 journey asserts `not.toContain("deepseek-chat $")` — Fix 3
  inverts that behavior; the assertion flips (expect per-model rows + cap
  line) in the same red-first change.
- `buildCostReport` direct 3-arg tests stay green (additive optional params).
- Mira's/Tom's toast assertions (`cost cap`, `LLM calls disabled`) stay
  green (toContain semantics preserved by appending, not replacing).

All fixes additive; no core-loop changes.
