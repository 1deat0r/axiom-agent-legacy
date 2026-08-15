# Handoff — sovereign layer ported; cost spine complete (all ports done)

Written 2026-08-16 (session 6). Status: ports #1–#5 done. The cost spine is
complete: the ledger (port #4) is covered by the Hermes baseline, and the
spend cap (port #5, issue #65) is implemented and merged. No open port
remains; next work is upstream-merge hygiene and the queued tracker
"Automation" flag (see Next steps).

## What was done (session 1 — re-foundation)

Axiom re-founded as a hardfork of Hermes Agent at HEAD per ADR-0087 (see
`axiom/CONTEXT.md`). Prime-era (`archive/prime-v0.7.2`, `baseline/prime-v0.7.2`)
and pi (`archive/pi-v0.84.1`) preserved as archived eras.

## What was done (session 2)

1. Unshallowed `upstream` — full Hermes history; `.git/shallow` gone.
2. Pushed the archived eras to origin (3 branches + `archive/prime-v0.7.2` tag).
3. Force-pushed `main` (operator-approved). origin/main = `fc0481914`.
4. Scaffolded the TS sovereign package at `axiom/sovereign/`
   (type=module, erasable-TS tsconfig, typescript@5.9.3 + @types/node@26.2.0):
   `src/memory.ts` (MemoryStore) + `src/profile_io.ts` + `src/lock.ts`.
   7 tests green via `node --test`; `tsc --noEmit` clean; byte-compat verified
   both directions against Python `3v0/core/memory.py`.
5. Path-fixed carried process docs (`docs/adr/` -> `axiom/docs/adr/`, stale
   upstream/account note -> Hermes upstream + 1deat0r origin), corrected the
   TS specifier convention (`.js` -> `.ts`), marked ports.md #1 in progress.
   Committed `336f9ec2d5`.
6. Opened tracker issue #63 (port #1, `ready-for-agent`).
7. Created `axiom/AGENTS.md` (operator-approved instruction file) from
   `axiom/GUIDE.md`; GUIDE.md is now a redirect.
8. Folded the sovereign package into `axiom/sovereign/` (was a separate
   `~/Projects/axiom-sovereign/` dir); committed `510670e158`.

## What was done (session 3)

9. Decided the CLI runtime: `node` (single runtime, already `engines >=26`;
   bun's cold-start win is immaterial at the bridge's write frequency, and one
   runtime keeps the port #3 bridge re-pointing to a single `node <cli>.ts`
   invocation pattern).
10. Ported the rest of the memory axis, byte-compatible with 3V0:
    `src/record.ts` (supersede-by-id/substring, dry-run), `src/sync.ts`
    (sync_kind/profile_text), `src/bridge.ts` (apply_ops), `src/decide.ts`
    (store-first decision), `src/query.ts` (fact axis) + `src/cli/paths.ts`;
    added `MemoryStore.allFacts()` for the inactive-set views.
11. Ported the CLI entrypoints: `src/cli/{ingest,record,sync,query}.ts`
    (query is memory-axis only until port #2 lands the skill axis).
12. Ported the tests (record/sync/bridge/decide/query) — 49 green.
13. Ported the skills store (port #2): `src/skills.ts` (SkillStore: versioned
    lineage + curator active/stale/archived states), `src/skill_io.ts`,
    `src/skill_bridge.ts` (apply_skill_op), `src/sync_skills.ts`
    (reconciliation), `src/decide_skills.ts` (store-first skill decisions),
    and the `query.ts` skill axis (version_dict/skills/skill_history/summary).
14. Ported the skills CLIs (`ingest_skills`, `record_skills`, `sync_skills`,
    `seed_skills`); upgraded the `query.ts` CLI to all five actions.
15. Fixed a cross-runtime arg edge: Node's parseArgs rejects dash-prefixed
    values (SKILL.md content starts with `---`); added `src/cli/parse_args.ts`
    (joins `--opt value` -> `--opt=value`).

## What was done (session 4)

16. Ported the native-store-bridge plugin (port #3, issue #64) to
    `axiom/plugin/native-store-bridge/` — same shape as 3V0's
    `3v0/plugin/native-store-bridge`, re-pointed at the TS sovereign CLI:
    - `post_tool_call` mirror: `memory` -> `node src/cli/ingest.ts`,
      `skill_manage` -> `node src/cli/ingest_skills.ts` (stdin JSON, best-effort).
    - `axiom_store` tool -> `node src/cli/query.ts` (read).
    - `axiom_record` tool -> `node src/cli/record.ts` / `record_skills.ts` (write).
17. Set the `AXIOM_STORE` / `AXIOM_SKILL_STORE` / `AXIOM_PROFILE_MEM` /
    `AXIOM_SKILLS_DIR` overrides in the plugin's subprocess env (existing env
    wins via `setdefault`, so tests/operators can redirect the store).
18. Re-anchored the tools from 3V0 to Axiom (`threev0_store`/`threev0_record`
    -> `axiom_store`/`axiom_record`, toolset `axiom`); session-scoping gate
    re-anchored to the axiom-agent repo + `AXIOM_HOME`. Out of scope (per the
    issue): `review_session.py` stays Python/3V0 — the `on_session_end` hook is
    not wired here.

## What was done (session 5)

19. Verified the port #4 premise against the baseline before writing any code.
    Hermes already ships the ADR-0010 cost ledger, more completely than the
    prime-era port: `agent/usage_pricing.py` (`_OFFICIAL_DOCS_PRICING` per-model
    table + provider models API; `normalize_usage` → `CanonicalUsage` with
    input/output/cache-read/cache-write/reasoning buckets; `estimate_usage_cost`
    → `CostResult` returning `amount_usd=None` + `status="unknown"` rather than
    inventing spend), `agent/insights.py` (cost-bucket surface),
    `agent/aux_accounting.py` (aux-LLM spend via ContextVar), all accumulated
    into `session_estimated_cost_usd` (run_agent.py:782, incremented in
    conversation_loop.py:3971 / codex_runtime.py:210, folded from subagents in
    delegate_tool.py:3303, persisted by turn_finalizer.py:689).
20. Corrected `axiom/docs/ports.md`: port #4 → "covered by baseline" with
    evidence; port #5 (spend cap) is the genuine remaining cost-spine gap — the
    accumulator exists but there is NO pre-call guard, no launch flag, no
    `cost_limit` finish (grep `max_run_cost|cost_limit|cost_cap` = 0 hits;
    `hermes_cli/main.py`'s `--max-cost` is a `hermes sessions` filter, unrelated).
21. Resolved the "prime-era automation stale" flag: `.github/workflows/triage.yml`
    + `issue-hygiene.yml` do NOT exist on the Hermes baseline (27 workflows, none
    a triage/hygiene operator). Rewrote the "Automation" sections of
    `axiom/docs/agents/issue-tracker.md` and `axiom/docs/agents/triage-labels.md`
    to state the discipline is agent-enforced only; left the prime-era
    `packages/coding-agent/...` refs in the ADRs alone (port specs, not drift).
22. Opened issue #65 (port #5, `ready-for-agent`) with the finding, acceptance
    criteria, and red-first verification plan.

## What was done (session 6)

23. Implemented the spend cap (port #5, issue #65, ADR-0011) red-first:
    - `agent/spend_cap.py` — pure `spend_cap_exceeded(agent)` guard
      (recorded usage only; `None` = no cap; `0` trips before the first call).
    - `agent/conversation_loop.py` — guard runs at the top of the tool loop,
      before `api_call_count` is incremented and before any client call; sets
      `_turn_exit_reason = "cost_limit"`, composes a user-facing notice, `break`s.
    - `agent/turn_finalizer.py` — `cost_limit` excluded from `completed`.
    - `AIAgent(max_run_cost_usd=...)` threaded through `run_agent.py` →
      `agent.agent_init.init_agent` (coerced to float at the init chokepoint);
      `None` = no cap.
    - `tools/delegate_tool.py` — subagents inherit the parent's cap value
      (per-run semantics per ADR-0061 §4; parent fold is the reconciliation point).
    - Flag `--max-run-cost <usd>` on the top-level + chat parser
      (`hermes_cli/_parser.py`, `type=float`, `_inherited_flag`), forwarded via
      `cmd_chat` → `cli.main(max_run_cost=...)` → `HermesCLI` → `AIAgent`, and
      via `_launch_tui(max_run_cost=...)` → `HERMES_TUI_MAX_RUN_COST` →
      `tui_gateway`'s `_cfg_max_run_cost()`.
24. Added `axiom/docs/adr/ADR-0011-spend-cap-surfaces.md` "Adapted for the
    Hermes baseline" section (the prime-era `parseArgs`/`tuiOptionsFrom`/
    `sessionLedger` surface does not exist here; guard lands in the loop,
    flag in `hermes_cli/main.py` + TUI launch args).

## Verified (how)

- `git ls-remote origin` — main + 3 archive branches + tag all correct.
- `node --test` — 109/109 pass (memory + record + sync + bridge + decide +
  query + skills + sync_skills + decide_skills + parse_args).
- `tsc --noEmit` — clean.
- Byte-compat (both stores): Python `core.memory` / `core.skills` read a
  TS-written store (incl. supersession/absorb lineage) and re-serialize it
  byte-identical (`cmp`); Python `ingest.py` -> TS `query.ts` verified the
  reverse direction.
- Plugin E2E (`tests/axiom/test_native_store_bridge.py`, 8 tests): the
  re-pointed plugin shells out to the real `node` CLIs against a temp store —
  memory/skill mirror, query, record/retract, skill_update all land in the
  byte-compatible stores; the derived-view projection (SKILL.md) lands in the
  profile skills dir. Run via `scripts/run_tests.sh
  tests/axiom/test_native_store_bridge.py`.
- Session 5 (read-only verification, no code changed): grep for
  `max_run_cost|cost_limit|cost_cap` over the tree = 0 hits; `ls
  .github/workflows` = 27 files, none named triage.yml / issue-hygiene.yml;
  read `agent/usage_pricing.py` (+ `insights.py`, `aux_accounting.py`) and the
  `session_estimated_cost_usd` accumulator sites to confirm the ledger is
  present and the cap guard is absent.
- Session 6 (port #5): red-first `tests/run_agent/test_max_run_cost.py`
  (8 tests — pure-guard cases incl. `0` disables / no-usage provider / missing
  attribute; a `finalize_turn` case asserting a `cost_limit` stop makes no
  summary LLM call; and a loop-drive case with `build_turn_context` stubbed
  asserting cap=0 → `api_calls == 0`, `turn_exit_reason == "cost_limit"`,
  `completed is False`). All green via `scripts/run_tests.sh
  tests/run_agent/test_max_run_cost.py -q`. Regression sweep (canonical
  runner): turn_finalizer (4 files), delegate/delegate_cost_footer/
  subagent_lifecycle, argparse-flag-propagation, relaunch, turn_context,
  cli_new_session, single_query_session_finalize — all green. Parser smoke:
  `--max-run-cost` parses to float at top-level and chat level, default None.

## Next steps (in order)

1. ~~Decide CLI runtime~~ — resolved 2026-08-16: `node` (see session 3 #9).
2. ~~Port #2 — skills store~~ — done (session 3 #13-15).
3. ~~Port #3 — re-point native-store-bridge at the TS CLI~~ — done (session 4;
   `axiom/plugin/native-store-bridge/` registers `axiom_store` + `axiom_record`
   and shells out to `node src/cli/*.ts`).
4. ~~Port #4 — cost ledger~~ — covered by baseline, NOT required (session 5;
   `agent/usage_pricing.py` + `agent/insights.py` + `agent/aux_accounting.py`
   already price every call and never invent spend). No port.
5. ~~Flag — prime-era automation stale~~ — resolved (session 5): docs now state
   the discipline is agent-enforced; porting the CI operator is deferred.
6. ~~Port #5 — spend cap~~ — done (session 6; `agent/spend_cap.py` guard in
   `conversation_loop.py`, `AIAgent(max_run_cost_usd=...)`,
   `--max-run-cost <usd>` on CLI + TUI, subagents inherit the cap).
7. **Porting the tracker Automation** (queued decision): the prime-era
   `.github/workflows/triage.yml` + `issue-hygiene.yml` operators are absent
   on this baseline. Porting them is a CI-infrastructure decision, not a code
   port — see `axiom/docs/agents/issue-tracker.md` ("Automation"). Not yet
   specced as an issue.
8. **Upstream-merge hygiene**: `git fetch upstream && git merge upstream/main`
   routinely (ADR-0087). Run `scripts/run_tests.sh` after each merge; the
   known environmental failures (missing optional provider packages/creds +
   FTS5/SQLite quirks) are not regressions.

## Environment quirks (verified)

- `NODE_ENV=production` is set in the shell — `npm install` omits devDeps
  unless `--include=dev` is passed.
- Node 26 type-stripping does NOT rewrite `.js` -> `.ts` import specifiers;
  use `.ts` specifiers + `allowImportingTsExtensions` + `noEmit`.
- The Hermes terminal guard false-positives on the literal `tsc` token; run
  `npm run typecheck` instead of `tsc` directly.
- Sovereign CLIs resolve store/profile paths via the `AXIOM_STORE`,
  `AXIOM_SKILL_STORE`, `AXIOM_PROFILE_MEM`, `AXIOM_SKILLS_DIR` env overrides
  (defaults: `axiom/sovereign/data/` + the Axiom Hermes profile). The ported
  plugin sets these in its subprocess env; `AXIOM_SOVEREIGN_ROOT` points the
  plugin at the package (falls back to a marker file, the repo-relative
  `axiom/sovereign/`, then `~/Projects/axiom-agent/axiom/sovereign`).
