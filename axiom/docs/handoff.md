# Handoff — one tool-dispatch seam (session 14)

Written 2026-08-16 (session 12). Status: ADR-0090 tool-dispatch seam shipped —
the triplicated dispatch pipelines (handle_function_call /
execute_tool_calls_sequential forks / invoke_tool intercept chain) are unified
behind a registry `agent_executor` contract; the dead-end stub and both name
lists are gone. Tracker: #68 closed, #69 (ADR-0091, bridge + execute_code →
dynamic-schema seam) open. Session-start ritual: the tree was refreshed onto
upstream (39 commits, `e107b91d64`) before this work, so no merge was needed.

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

## What was done (session 10)

36. Authored the Axiom TUI theme as a user skin (`axiom`), per ADR-0088:
    evergreen-and-mint palette (background `#0b1210`, accent `#35d694`),
    name "Axiom", icon `◈`, prompt `∴`, tagline "Sovereign agent · keeper of
    the garden", attribution "Axiom", an AXIOM ASCII `banner_logo` (ANSI
    Shadow, exact via pyfiglet) + a `∴` `banner_hero`, and spinner faces
    (`∴ ◈ ◇ ○ ⊕`) + verbs (deriving/deducing/tending/harvesting…). Canonical
    copy at `axiom/skin/axiom.yaml`; installed to
    `~/.hermes/profiles/axiom/skins/axiom.yaml` and activated via
    `display.skin: axiom` — verified `hermes -p axiom skin list` shows
    `* axiom` and the engine resolves icon/tagline/attribution.
37. Widened the skin surface (ADR-0088): added `icon`/`tagline`/`attribution`
    to `SKIN_BRANDING_TOKENS` (`apps/shared/src/skin.ts`), `ThemeBrand` +
    `fromSkin` (`ui-tui/src/theme.ts`), and the banner renderer
    (`ui-tui/src/components/branding.tsx`); the status-bar seal now reads the
    theme icon (`appLayout.tsx`). Hermes defaults preserved as fallbacks.
    Rebuilt `ui-tui/dist/entry.js`; `npm run typecheck` clean; 170/170 across
    the theme/branding tests (incl. a new `theme.test.ts` case for the three
    tokens). The full `npm test` run has a pre-existing `hermes-ink`
    backpressure flake (upstream #54171) unrelated to this work.
38. Environment incident: `uv run --with pyfiglet` recreated `.venv` (a uv
    gotcha — running with different extras than the venv was created with
    forces a recreate) and dropped the `[all]`+`dev` extras. Restored with
    `uv sync --extra all --extra dev --locked`; re-verified `hermes --version`
    (v0.20.1) and the two port suites (16/16). Lesson: use `uvx` for
    throwaway tooling, never `uv run --with` against the project venv.

## What was done (session 11)

39. Local vision (ADR-0089): pulled `qwen2.5vl:7b` (Qwen2.5-VL-7B @ Q4_K_M,
    6.0 GB) into the already-installed Ollama 0.32.13 (system service,
    `/var/lib/ollama`). Pinned `auxiliary.vision` to `provider: custom`,
    `model: qwen2.5vl:7b`, `base_url: http://localhost:11434/v1` via
    `hermes config set` (never hand-edited config.yaml). Local model is
    vision-only — the text brain stays DeepSeek (`-flash`/`-pro`). Verified
    the route is decoupled from the main model (`-flash`, `-pro`, and no
    binding all resolve vision to the local endpoint), and E2E through
    Hermes's own `async_call_llm(task="vision")` transcribed a test image
    verbatim. ImageMagick-rendered test images read as tofu boxes (font /
    16-bit artifacts); a PIL-rendered image read correctly — the failure was
    the test image, not the model.
40. Activated the sovereign-store plugin (completes port #3's live wiring):
    copied `axiom/plugin/native-store-bridge/` into
    `~/.hermes/profiles/axiom/plugins/`, enabled it
    (`hermes plugins enable native-store-bridge`), and enabled the `axiom`
    toolset (`hermes tools enable axiom --platform cli`). Verified live:
    `validate_toolset("axiom")` → True, `resolve_toolset("axiom")` →
    `['axiom_record', 'axiom_store']`; a registry-dispatched `axiom_record`
    write + `axiom_store` read round-tripped a fact through the
    byte-compatible TS store (then retracted it, leaving the store clean).
41. Wrote ADR-0089 (`axiom/docs/adr/ADR-0089-local-vision-vlm.md`).

Known follow-up (not fixed): the `axiom` toolset is enabled for the `cli`
platform, but `hermes tools` has no `tui` platform and the TUI resolves its
toolsets via `_load_enabled_toolsets("tui")` (coding posture /
`HERMES_TUI_TOOLSETS`). The toolset resolves, but whether a live TUI turn
actually receives `axiom_store`/`axiom_record` is unverified — confirm on the
next TUI session, or pin `HERMES_TUI_TOOLSETS`.

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

## What was done (session 12)

42. Ran the improve-codebase-architecture skill (mattpocock) over the tool
    subsystem with an independent subagent walk; report at
    /tmp/architecture-review-1786870124.html — 10 deepening candidates. The
    operator picked C1 (one dispatch seam); the design was grilled to
    convergence (all frontier decisions operator-approved).
43. Implemented ADR-0090 (`axiom/docs/adr/ADR-0090-tool-dispatch-seam.md`),
    red-first, in two commits (`c9ba1b7d22` tests, `c2990000e3` refactor):
    - `ToolEntry` gains `agent_executor(agent, args, ctx)` and
      `after_authorization(agent)`; `registry.dispatch_agent_executor` /
      `get_agent_executor` / `get_after_authorization` are the public seam.
    - The nine agent-level tools register executors beside their schemas
      (todo, session_search, memory, clarify, read_terminal, read_preview,
      read_window_below, setup_mcp, delegate_task); memory + skill_manage
      register `after_authorization` for the counter resets (timing preserved:
      post-guardrails, pre-execute, blocked never fires).
    - Sequential executor and `invoke_tool` resolve through the registry —
      13 name-forks + the invoke_tool intercept chain deleted; the delegate
      branch keeps spinner display sugar only.
    - `_AGENT_LOOP_TOOLS` + the "must be handled by the agent loop" stub
      deleted; agent-less callers degrade uniformly through each tool's
      registry handler (session_search returns a harmless browse-mode result,
      the rest return their own errors).
    - Approval-hook correlation IDs (`set/reset_current_observability_context`)
      now wrap every dispatch, including the executor paths that previously
      skipped them.
    - Net −10 lines (353 insertions, 363 deletions).
44. Verification: `tests/run_agent/test_tool_dispatch_seam.py` (13 tests, red
    first) pins the contract. Full sweep over tests/run_agent + test_model_tools
    + tool_search + dispatch_session_id + transform/sanitize + the two Axiom
    port suites: 255+ green; 7 failures, all pre-existing environment gaps in
    the shared test venv (`~/.hermes/hermes-agent/venv` has pytest but no
    `anthropic`; 6 anthropic-provider tests + 1 nous-token test — none touch
    the dispatch diff). The sweep caught two real regressions (session_search
    tests patching the old call-time import mechanism) — fixed by re-patching
    the real module attribute the registered executor calls.
45. Tracker: #68 (ADR-0090 reservation) opened at start and closed with the
    audit comment; #69 (ADR-0091 reservation — bridge tools + execute_code →
    dynamic_schema_overrides) opened and stays open as the follow-up.
    Environment note: installed the `anthropic` extra into `.venv`
    (`uv sync --extra anthropic --locked` — safe, no recreate); the shared
    test venv was left untouched.
46. Closed the code-review loop on ADR-0090: two-axis review (Standards +
    Spec, parallel sub-agents) → fixes landed (`87fed0dc44` production seam,
    shared `executor_ctx` factory, `observability_context` context manager,
    stale comment, stronger degradation pins; `a1af0c8573` debug logging on
    the defensive degradation paths). Declines documented: `after_authorization`
    name kept (ADR vocabulary), broad excepts now logged not silent.
47. Implemented ADR-0091 (#69, red-first, one commit): the dynamic-schema
    seam is now context-aware — `registry.get_definitions` is two-pass
    (check_fn pass → candidates frozenset → overrides pass), and
    `dynamic_schema_overrides` may accept `available_tool_names`
    (signature-inspected; zero-arg callables unchanged). Dict → merge,
    None → drop. The four assembler name-cases moved beside their tools:
    execute_code (sandbox list), discord/discord_admin (intent probe, None
    drops), browser_navigate (web cross-ref strip), browser_exec (terminal
    gate, None drops). `_compute_tool_definitions` now knows no tool names.
    Bridge dispatch forks stay (out of scope, documented in the ADR).
    Tests: `tests/run_agent/test_dynamic_schema_seam.py` (8, red first) pins
    both seams; sweeps green (329 schema/registry tests, full tests/run_agent
    with the same 7 pre-existing env-gap failures: no `anthropic` in the
    shared test venv + 1 nous-token test).

48. Session ritual (ADR-0087) at session start: `git fetch upstream` found
    new commits (a15de34545..f4c80e4243); merged cleanly (af472cab4d — the
    merge touched tools/approval.py +182 and other files but no seam
    conflicts); the ritual suites (test_max_run_cost,
    test_native_store_bridge, test_tool_dispatch_seam,
    test_dynamic_schema_seam) green 30/30.
49. RESOLVED the session-11 carryover — live TUI axiom-toolset verification.
    Simulated the real launch env (HERMES_HOME=profile, cwd=repo):
    `_load_enabled_toolsets("tui")` resolves `axiom` via the CLI fallback
    (no HERMES_TUI_TOOLSETS pin needed); pre-assembly definitions ship
    `axiom_store` + `axiom_record`; with progressive disclosure active
    (tier 1, 5 plugin tools deferred) both remain reachable in the embedded
    bridge catalog via tool_search → tool_call. Verdict: a live TUI turn
    receives the axiom tools as designed (plugin tools defer behind the
    bridge — the repo's own tiered-disclosure doctrine), no code change
    needed.
50. Implemented ADR-0092 (C2, red-first, one commit): the argument-coercion
    cluster extracted from model_tools.py into a new root-level
    `tool_args.py` (interface unchanged — coerce_tool_args + the six helpers;
    no shims). model_tools.py shrank 322 lines; test imports moved to
    tool_args. Sweeps green (76 coercion/dispatch tests; full tests/run_agent
    with the same 7 pre-existing env-gap failures).

51. Implemented ADR-0093 (C9, red-first, one commit): `registry.generation()`
    is the public read (six memo sites re-pointed), `restore_registration`
    now bumps the generation (missing-bump bug), the plugin-dev teardown
    crosses a new `restore_global_slots` bulk-restore seam instead of
    mutating `_tools`, and `model_tools.TOOL_TO_TOOLSET_MAP` /
    `TOOLSET_REQUIREMENTS` are live snapshots via module `__getattr__`.
    Tests: `tests/tools/test_registry_generation.py` (3, red first).
    Sweeps green (159 registry/doctor/seam tests, plugin-dev 5/5, full
    tests/run_agent with the same 7 pre-existing env-gap failures).
52. Implemented ADR-0094 (C3, red-first, one commit): wired the dead
    upstream `evaluate_url_safety` into the seam — signature widened to
    `(url, task_id=None)`, owning the hybrid-routing sidecar exemption;
    browser_navigate's 81-line inline guard duplicate deleted (the guard
    owns the decision, navigation re-derives the session key for its
    mechanics). Snapshot/vision current-page revalidation guards stay
    (different contract, documented). Tests:
    `tests/tools/test_browser_url_guard_seam.py` (8, red first); sweep
    212 green across the full browser guard surface + seam suites.
53. C4 (browser availability consolidation) — grilled, then DECLINED as
    superseded: the merge already built the delegation chain
    (dialog→cdp→check_browser_requirements; vision→browser; browser→
    use-cli-mode gate) and the remaining probes are distinct contracts
    (managed-first uvx finder vs validated extended-PATH/npx finder;
    camofox HTTP health; CDP-URL gate). ADR-0095 records the evidence and
    the decline; the injectable-probe-registry idea stays deferred.
    No code change — the deletion test said consolidating would move
    complexity, not concentrate it.

## What was done (session 13 — 2026-08-17)

Opened as a `/grilling` run (mattpocock router) on "what to ship next", converged on a sharpened brief, then closed the engine gaps the brief exposed.

53. Grilled to convergence: **ship the story, not more hardening** — hook = cost-visible + spend-capped (sovereign as second pillar), buyer = solo operators, surface = demo-first, motion = founder's-tier pre-sell by month-end.
54. Fact-checked the money thesis live before building (background subagent): cap works on `chat -q` but `-z` ignored it; per-session cost was machine-only (no human-facing readout beyond the cap notice); a spurious "Unknown toolsets: axiom" warning printed every chat init; the sovereign store round-trips.
55. Three red-first fixes, committed + live-verified:
    - `f8046c2cee` `-z` cap-bypass: thread `max_run_cost` → `AIAgent(max_run_cost_usd=…)` (3 call sites). 3 tests; live `-z --max-run-cost 0` stops pre-call.
    - `6264ea9901` cost-visible: `format_session_cost` (never invents spend) + `Cost:` line in `_print_exit_summary`. 5 tests; live `chat -q` prints `Cost: ~$0.02`.
    - `814cfbfe6f` toolset warning: `discover_plugins()` re-check on an unresolved toolset. Live-verified warning gone.
56. `bbbafc6152` landing at `axiom/story/index.html` (on-brand, verified copy, live-captured demo transcript, founder's-tier CTA).
57. Pushed `1158368e1b..bbbafc6152`.
58. Wrote ADR-0096 — the go-to-market decision: ship the story (not more hardening), cost-visible + spend-capped hook, solo operators, founder's tier at $29/mo / $199 lifetime, 25 seats.
59. Tracker: opened + closed #70 (`-z` cap-bypass) and #71 (cost-visible gap) with audit comments referencing the fix commits.
60. Recorded the demo: a real spend-capped `chat -q` run wrote `axiom/story/RELEASE-NOTES.md` (9 tool calls, `Cost: ~$0.02`, 22s); the landing demo section now carries that real capture.
61. Added the `/usage` "Estimated cost" line (ADR-0097) — re-surfaced cost-visible on `/usage`, gated on known pricing, diverging from upstream #52717. Red-first: 2 new tests pin shown-when-priced / omitted-when-unknown; the legacy-cost test renamed.
62. Upstream-merge ritual (ADR-0087) attempted but **blocked**: upstream moved 82 commits ahead, and `git merge` is refused by Hermes's live-checkout guard (this session runs *from* the repo). Deferred to a non-running session.

## Verified (how)

- Unit: `test_oneshot_max_run_cost.py` 3/3; `test_usage_pricing.py` 45/45.
- Live: `-z --max-run-cost 0` stops pre-call; `chat -q` shows `Cost: ~$0.02`; "Unknown toolsets" gone.
- Sweep (`tests/run_agent/ tests/cli/ test_usage_pricing test_insights`): 257 passed, 7 failed — all pre-existing env gaps (no `anthropic` in the shared test venv: 6 anthropic + 1 nous-token), none touch these changes.

## Open (not done)

- **Upstream merge (ADR-0087) — 82 commits behind, blocked.** `git merge` is refused from this running checkout (Hermes live-source guard). Do it in a non-running session: `git fetch upstream && git merge upstream/main`, then re-run the ritual suites (`test_max_run_cost`, `test_native_store_bridge`, `test_tool_dispatch_seam`, `test_dynamic_schema_seam`, `test_oneshot_max_run_cost`, `test_usage_pricing`, `test_cli_status_bar`).
- TUI live-spend status-bar (accumulator already computed) — defer until after the upstream merge (upstream's 82 commits are TUI/desktop-heavy).
- Founder's-tier price decided in ADR-0096 ($29/mo / $199 lifetime, 25 seats); the landing page CTA still needs a real payment link.
- Pre-existing dirty tree (NOT this session): `plugins/platforms/telegram/adapter.py` (modified) + `tests/gateway/test_telegram_lazy_reimport.py` (untracked).
- Code-review follow-ups (judgement calls, not fixed): (1) automated E2E test for the `-z` cap threading (currently unit + live-verified only); (2) the cap-trip notice in `conversation_loop.py` formats cost inline (`$`/`.4f`) — unify with `format_cost_label`; (3) minor DRY of the footer/`/usage` display blocks.

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

## What was done (session 14 — 2026-08-17)

Continued autonomously: unblocked the upstream merge (session 13's blocker) and closed the pre-existing dirty tree.

63. Committed the long-dirty Telegram fix that was blocking the merge: `6195367166` `fix(telegram): rebind TypeHandler on lazy SDK re-import`. `check_telegram_requirements()` re-imported every PTB symbol after a lazy install but omitted `TypeHandler` (left `typing.Any`), so `_register_handlers` raised `TypeError: Any cannot be instantiated` and killed the Telegram connect at gateway boot. Red-first regression test `tests/gateway/test_telegram_lazy_reimport.py` (1 test).
64. Merged upstream `main` (82 commits) as `314de58699`. NOT in-place: Hermes's live-checkout guard refuses `git merge` from this running checkout, so I followed its sanctioned path — `git clone --shared` into `~/.hermes/profiles/axiom/scratch/merge-upstream` (real disk, not /tmp), merged + tested there, pushed to origin. Pushed `6132bc8753..314de58699`.
65. Cost-spine + TypeHandler confirmed intact across the merge (upstream refactored `hermes_cli/main.py` +279 lines and `cli.py` +101): `format_session_cost`, the `Cost:` footer + `/usage` line, `max_run_cost` threading, and the TypeHandler rebind all present. Targeted suite 75/75 green.
66. Full-suite gate: 29,593 tests, 78 failed — ALL pre-existing, ZERO merge regressions. Proven by re-running the 8 non-obvious failures on a pre-merge worktree (identical failures) and classifying the other 70 as env gaps (`anthropic` missing from the shared test venv, Daytona/Fal/video-gen/hindsight API keys, live-provider payment errors).

## Verified (how)

- Unit: 75/75 targeted (oneshot 3, usage_pricing 47, cli_status_bar 24, telegram 1).
- Full suite (clone): 29,593 run, 78 failed — baseline-confirmed pre-existing.
- compileall: clean across `hermes_cli/ agent/ cli.py plugins/platforms/telegram`.

## Open (not done)

- The LIVE checkout (`~/Projects/axiom-agent`) is still at `6195367166`; it can't fast-forward while Hermes runs from it. After the next restart: `git pull origin main` (or `git merge --ff-only origin/main`).
- Session 13's "Open" items otherwise stand (TUI live-spend bar after the merge lands locally; payment link; code-review follow-ups).

## Next session (standing)

The port queue is empty; the tracker has only the passive ledger (#67). A
fresh session opens with the ADR-0087 ritual (fetch upstream, merge if
ahead, run `test_max_run_cost` + `test_native_store_bridge` +
`test_tool_dispatch_seam` + `test_dynamic_schema_seam`, check the tracker)
and then asks the operator what's next. Two items carry over: (1) relaunch
the TUI (`axiom`) to see the full Axiom theme (session 10); (2) the
remaining architecture-review candidates C2–C10 are documented in the
session-12 report — `improve-codebase-architecture` candidates, pick from
the report if hardening continues. (The axiom-toolset TUI question is
resolved — session 12 §49: available via the tiered-disclosure bridge.)

## Environment quirks (verified)

- `uv run --with <pkg>` against the project recreates `.venv` and drops the
  extras the venv was created with (a uv gotcha). Use `uvx` for throwaway
  tooling; restore with `uv sync --extra all --extra dev --locked`.
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

- The Hermes live-source guard refuses `git merge`/`git reset` on the running
  checkout (`~/Projects/axiom-agent`) — it would mix module versions in the
  live process. To merge upstream while Hermes runs: `git clone --shared
  ~/Projects/axiom-agent ~/.hermes/profiles/axiom/scratch/<task>` (real disk,
  NOT /tmp — tmpfs fills on dep installs), merge + test there, push to
  origin, then delete the clone. The live checkout fast-forwards on the next
  restart (`git pull origin main`).

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
