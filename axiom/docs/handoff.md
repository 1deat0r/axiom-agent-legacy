# Handoff — tracker automation ported and activated, all ports done (session 9)

Written 2026-08-16 (session 9). Status: ports #1–#5 done; the tracker
automation CI (triage + issue-hygiene) is ported (issue #66, session 8) and
now ACTIVATED (session 9): Actions is enabled, both workflows are live, and
`HYGIENE_SUMMARY_ISSUE` points at a fresh open ledger issue (#67). The
upstream merge is current (session 9: zero new upstream commits;
`upstream/main` is an ancestor of HEAD). The tracker has one open issue —
the ledger (#67), a passive record, not a task.

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

## What was done (session 7)

25. Upstream-merge hygiene (ADR-0087): `git fetch upstream && git merge
    upstream/main` — 22 commits (computer-use fixes, session picker
    lifecycle, terminal breadcrumbs + per-terminal `--continue`, Claude
    Code/Codex session import, desktop Skills tab hub, nemo_relay bounded
    marks, gateway session-finalize off-loop, Windows shim quarantine
    restore, durable row_id stamps). Clean merge, no conflicts, no `axiom/`
    changes, and none of the 22 commits touched the spend-cap surfaces
    (`agent/conversation_loop.py`, `turn_finalizer.py`, `init_agent.py`,
    `delegate_tool.py`, `_parser.py`, `toolsets.py`).
26. Regression sweep after the merge, all green via `scripts/run_tests.sh`
    (0 failures, 258 tests): the port suites (test_max_run_cost 8/8,
    test_native_store_bridge 8/8); the upstream-touched suites (session
    lifecycle status, terminal breadcrumbs, foreign sessions, quarantine
    no-op restore, finalize off-loop, nemo_relay bounded marks, computer-use
    authorization/display-guard/empty-discovery/placeholder-ids); the
    canonical session-6 sweep (turn_finalizer ×3, turn_context ×2,
    cli_new_session, single_query_session_finalize, cli_delegate_background,
    relaunch, argparse_flag_propagation, gateway turn_context, delegate,
    delegate_cost_footer, delegate_subagent_timeout — 158 green, 4 skipped).
27. Pushed `main` to origin (`9e00aec9ac..6c3c724cf7`) — a routine
    fast-forward of merged work; origin/main is now at the merge commit.
    This also carried session 6's unpushed `b33c53aac2` (launch procedure
    docs) to origin.
28. Closed the two open prime-era tracker issues as superseded by the
    re-foundation, bookkeeping form (no code):
    - #61 (forkserver orphans) — target `packages/coding-agent/src/core/
      kernel/` exists only on `archive/prime-v0.7.2`; the Hermes baseline has
      no kernel manager/forkserver code (tree-grep verified), so there is no
      port target. The live hygiene it named was already cleared (the #52
      housekeeping comment: no orphan daemons, all 12 tmp dirs removed). The
      harness axiom sessions run on is the external npm package
      `prime-agent@0.7.2` (PrimeIntellect upstream) — a fix there would be an
      upstream contribution, not this repo's work. Reopening is one click if
      the operator wants it redirected.
    - #62 (telemetry-notice stderr leak) — targets
      `packages/coding-agent/.../agent-session-services.ts` + the archived
      `4685-daemon-client-modes.test.ts`; no Axiom telemetry notice exists on
      the Hermes baseline (grep verified). Same disposition.
    Both closes carry audit comments with the evidence; the tracker is empty.

## What was done (session 8)

29. Session-start ritual (ADR-0087): `git fetch upstream && git merge
    upstream/main` was a no-op — zero commits on upstream since session 7
    (`upstream/main` = `460d345642`, an ancestor of HEAD). Baseline health
    re-confirmed with the two Axiom port suites
    (`test_max_run_cost` + `test_native_store_bridge`, 16/16 green);
    tracker confirmed empty.
30. Ported the tracker automation CI (issue #66, the queued decision from
    session 7) to `axiom/gh-tooling/`: `src/triage.ts`, `src/hygiene.ts`,
    and the three stdin→JSON CLIs copied from the prime-era
    `packages/coding-agent/src/core/gh-tooling/` with three surgical
    adaptations (`.ts` import specifiers; docs pointers →
    `axiom/docs/agents/*`; verification mention → `scripts/run_tests.sh`
    (Python) + `node --test` + `npm run typecheck` (TS)). Zero runtime deps
    beyond `tsx`. Tests ported first, red-first — 62/62 green via
    `node --test`; `npm run typecheck` clean.
31. Re-pointed `.github/workflows/triage.yml` +
    `.github/workflows/issue-hygiene.yml` at `axiom/gh-tooling/src/*.ts`
    (prime-era files verbatim otherwise, except `actions/checkout`
    SHA-pinned per the dependency-pinning policy). Verified the workflow's
    exact Decide/Check invocations against live `gh` output for #66.
32. Re-anchored docs: issue-tracker.md + triage-labels.md Automation
    sections now state the CI is ported and name the two operator
    activation steps; ADR-0050 + ADR-0064 gained "Adapted for the Hermes
    baseline" sections (ADR-0011 precedent).
    Full details: `axiom/docs/handoff-tracker-automation.md`.

## What was done (session 9)

33. Session-start ritual (ADR-0087): `git fetch upstream && git merge
    upstream/main` was a no-op — zero commits on upstream since session 8
    (`upstream/main` = `460d345642`, an ancestor of HEAD). Baseline health
    re-confirmed with the two Axiom port suites
    (`test_max_run_cost` + `test_native_store_bridge`, 16/16 green).
34. Confirmed both operator activation steps from the session-8 handoff are
    in fact DONE: Actions is enabled on the fork (`actions/permissions`
    → `enabled: true`), and both ported workflows are live (`Issue triage`,
    `Issue hygiene sweep`).
35. Found `HYGIENE_SUMMARY_ISSUE` was set to `42` — a CLOSED prime-era
    issue. The sweep still posts there (GitHub allows commenting on closed
    issues), but the weekly summary would accumulate on a buried issue.
    Per the operator, opened a fresh open ledger issue (#67, label
    `wontfix` = "no work to do", body states it is a passive record not a
    ticket) and repointed the repo var `HYGIENE_SUMMARY_ISSUE` → `67`.
    Verified the `opened` + `labeled` triage runs skipped #67 cleanly
    (0 comments, no label change), so the ledger will not be swept or
    nagged.

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
7. ~~Porting the tracker Automation~~ — done (session 8, issue #66;
   `axiom/gh-tooling/` + the two re-pointed workflows, see
   `axiom/docs/handoff-tracker-automation.md`) and ACTIVATED (session 9):
   Actions enabled, both workflows live, `HYGIENE_SUMMARY_ISSUE` repointed
   from closed #42 to the open ledger #67.
8. ~~Upstream-merge hygiene~~ — standing routine per ADR-0087, not a
   one-time item: every session starts with `git fetch upstream && git merge
   upstream/main` and re-runs the sweep before doing anything else. Session
   8 start: no-op (zero new upstream commits).

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

## Launch procedure (3V0 session, 2026-08-16)

Axiom now launches cleanly — the `max_run_cost_usd` import-mix error is fixed.

- **Launcher:** `~/.local/bin/axiom` (replaces the old dangling symlink to the
  archived `packages/coding-agent/dist/cli.js`). It unsets the 3V0-session
  `HERMES_*` / `PYTHONPATH` / `PYTHONHOME` / `TERMINAL_CWD` leak, `cd`s into
  this repo, then `exec .venv/bin/hermes -p axiom "$@"`.
- **Profile:** `~/.hermes/profiles/axiom/` — `SOUL.md` = `axiom/SOUL.md`,
  deepseek-v4-pro config, shared `DEEPSEEK_API_KEY`, `axiom_body_path`,
  `profile.yaml`.
- **Root cause of the old error:** the 3V0 session exports
  `HERMES_PYTHON_SRC_ROOT=~/.hermes/hermes-agent` (the older shared runtime,
  pre-spend-cap). `hermes_bootstrap.harden_import_path()` read it and forced
  `run_agent` onto that runtime, pairing a `tui_gateway` that passes
  `max_run_cost_usd` with an `AIAgent` that doesn't accept it. Stripping the
  var makes `run_agent` resolve here.
- **Verified:** `axiom --version` → install dir `~/Projects/axiom-agent`;
  `axiom chat -q "…"` → inits and self-identifies as Axiom (not 3V0);
  `run_agent` + `tui_gateway` both import from this repo and `AIAgent.__init__`
  accepts `max_run_cost_usd`.
- **Explicit command (no launcher):**
  `cd ~/Projects/axiom-agent && env -u PYTHONPATH -u HERMES_PYTHON_SRC_ROOT -u HERMES_PYTHON -u HERMES_HOME -u TERMINAL_CWD .venv/bin/hermes -p axiom --tui`
