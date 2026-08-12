# Delegate + script-as-tool RPC — running log

Feature #5 first step: RPC bridge that spawns a helper process and returns only a
compact result block into the parent session (Hermes delegate_tool.py analog).

| # | Step | Result |
|---|------|--------|
| 0 | Preflight: repo docs, extension patterns, RLM/RPC infra, test harness | Done. Built on RPC bridge (RpcClient -> `--mode rpc`), newest-new-surface, matches Hermes "spawn helper process". |
| 1 | Plan written (docs/plans/delegate-tool.md) | Done. |
| 2 | Self-review of plan | see log below |
| 3 | External review of plan | see log below |
| 4 | Implement | pending |
| 5 | Self-review impl | pending |
| 6 | External review impl | pending |
| 7 | summary.html | pending |

## Self-review (plan) — round 1
_notes appended during review_

## External review (plan)
_notes appended during review_

## Self-review (plan) — round 1
Scored plan vs rubric:
- Correctness 4/5 — end-to-end + error path covered, but NO explicit test that a
  timed-out/errored helper is stopped (bridge.stop() in finally).
- Fit 5/5 — reuses RpcClient + fakePi extension pattern; new files only + 1 line
  in extensions/index.ts; additive.
- Testability 4/5 — pure + stub-bridge + live-gated; but NO test asserting the
  helper is RESET between delegate calls (new session per call).
- Risk 4/5 — orphan-process on timeout documented but untested; no test that
  stop() is invoked on the failure path; concurrency (parallel calls = separate
  processes) not stated.
- Clarity 4/5 — live-gated test step underspecified (needs dist/cli.js +
  skipIf(!ANTHROPIC_API_KEY && !ANTHROPIC_OAUTH_TOKEN)).
Weaknesses found (>=2): (a) timeout/abort stop() untested; (b) per-call new-session
reset untested; (c) live-gated step vague. Fixing all three.

## Self-review (plan) — round 2
All three raised weaknesses fixed:
- (a) timeout/abort -> stub test: never-resolving bridge returns {ok:false} AND
  bridge.stop() called exactly once (no orphan).
- (b) per-call reset -> test: two sequential calls each request a NEW helper session.
- (c) live-gated step clarified: describe.skipIf(!ANTHROPIC_API_KEY &&
  !ANTHROPIC_OAUTH_TOKEN), dist/cli.js, mirrors rpc.test.ts.
Concurrency risk now stated. Re-score: Correctness 5, Fit 5, Testability 5,
Risk 5, Clarity 5. Plan approved at self-review (>=90/100 equivalent).

## External review (plan) — round 1 — APPROVE 94/100
Reviewer: RLM subagent delegate-plan-reviewer (real spawned child, read the plan, scored).
Correctness 4.5, Fit 5, Testability 5, Risk 4.5, Clarity 4.5 -> total 94/100, APPROVE.
Non-blocking notes to fold into implementation:
1. Resolve wording: per-call reset = one FRESH spawned helper process per delegate call
   (start/runTask/stop); keep consistent everywhere.
2. lastAssistantText: RpcClient HAS `getLastAssistantText()` (line 416) — use it; reviewer
   note superseded; still need a fallback for tool-only final turns.
3. Define DelegateTokenAccounting = SessionStats.tokens (input/output/cacheRead/cacheWrite/
   total) + cost; concrete summaryMaxChars = 2000.
4. Fallback when final turn has no assistant text: summary = "(no textual summary captured)".
POST-APPROVAL: fold all 4 into implementation; proceed to implement.

## Implement (steps 4-5)
- files: types.ts, result.ts, bridge.ts, index.ts; wired into builtInExtensions; test file.
- delegate.test.ts: 19 neutral tests (stub bridge) pass; 1 live-gated skipped; biome clean;
  tsgo --noEmit clean; sensitive extension tests (trigger-compact, compaction-extensions,
  interactive-mode-status) pass.
- committed 43d31b45a (source + test + log).

## Self-review (impl) — round 1
Checklist:
- All planned items present: types/result/bridge/index + builtInExtensions wiring + test. ADR/handoff/summary pending (step 8).
- Tests pass; assert real behavior (cap truncation, timeout => exactly-once stop, per-call reset,
  no-transcript keys, error path, clamp).
- No TODOs/debug prints/dead code; withTimeout attaches settle handlers so a late rejection is safe.
- Edge cases handled: empty task (throws), timeout (ok:false + stop), error (ok:false + stop),
  no textual summary (NO_SUMMARY_TEXT fallback), timeoutMs clamp.
PASS. Proceeding to external review of impl.

## External review (impl) — round 1 — DENY 84/100
Reviewer: RLM subagent delegate-impl-reviewer. Correctness 4, Fit 4, Testability 4, Risk 4,
Clarity 5 -> 84/100 DENY. Two exact fixes:
1. `model` param declared + echoed into helper.model but NOT applied to the helper.
2. timeout clamp mishandles non-finite (NaN -> setTimeout ~0 instant false timeout).
FIXED in commit 9f4fe96fb: thread model via parseModelRef into createRpcClientBridge on the default
factory (+ test), guard clamp with Number.isFinite (NaN/Infinity -> default) and floor negatives to 1
(+ tests).

## External review (impl) — round 2 — APPROVE 96/100
Reviewer: RLM subagent delegate-impl-reviewer-2. Both fixes verified in source + independent test run
(22 passed / 1 live-gated skipped). Correctness 5, Fit 5, Testability 5, Risk 4 (real helper-process
path only live-gated), Clarity 5 -> 96/100 APPROVE. No new blocking issues.

## Docs + summary
ADR-0029, handoff-delegate-tool.md, summary-delegate-tool.html built from this log.

## Floor check — full ./test.sh
4393 passed / 15 failed / 60 skipped. The 14 are ONLY the documented sandbox
known-fails (daemon-serialized-refine 1, 4603-worker-recovery 4,
4685-daemon-client-modes 9 = EXDEV hard-link / real-process). The 15th,
kernel-agent-message-skill (agent_message broadcast receipts, 30s timeout), is a
parallel-load flake: it references none of this change and passes 7/7 standalone
(2.85s). NO new regressions. biome clean, tsgo clean, delegate suite 22 green.

## Continuation — closing the live-model + identity gap (feature #5, still open)
First step was complete; feature #5's later steps remain. Continue with sandbox-doable
increments toward full implementation:
- (A) Propagate the PARENT's live provider/model into the helper by default (ctx.model),
      falling back to an explicit `model` param when supplied — fixes the residual gap the
      impl-reviewer docked. Surfaced as helper.model = the model actually used.
- (B) Surface helper.sessionId (from helper SessionStats) in the compact block.
- (C, later) batch/parallel async_delegation + delegation_output_schema.

## Increment (A)+(B) — live model propagation + helper identity
- execute now reads ctx (ExtensionContext) and resolves the helper model: explicit `model`
  param wins, else defaults to the parent's LIVE model (ctx.model provider/id). Surfaced as
  helper.model = the model actually used. helper.sessionId surfaced from helper SessionStats.
- tests: 24 neutral passed / 1 live-gated skipped; tsgo clean; biome clean.
- self-review: parent-live-model fallback + sessionId surfacing each have a test that fails
  without the change; explicit param wins; empty model param falls through to parent; additive
  (execute ctx is optional in tests). No dead code.
COMMIT: git commit the increment.
- Increment (A)+(B) external review: delegate-incr-reviewer APPROVE 98/100. Non-blocking: empty
  model-param fallback has no dedicated test -> ADDED (25 neutral / 1 live-gated skipped).
COMMIT+push increment.

## Increment (C) — batch/parallel fan-out (Hermes batch/parallel + async_delegation)
- New `tasks?: string[]` param: run one FRESH helper per task concurrently (Promise.all),
  each reaping its own bridge; returns an aggregate `DelegateBatchResult {ok, delegations[],
  tokens, cost}` (ok = AND across delegations; a failing task keeps sibling results / ok:false).
- `task` became optional (single) alongside `tasks` (batch); validation requires one.
- Shared runDelegation() extracted for single+batch (DRY, no orphan, per-delegation timeout).
- result.ts: addAccounting, toBatchResult, renderBatchResult.
- tests: 28 neutral / 1 live-gated skipped; tsgo clean; biome clean. New tests: batch fresh-per-task
  (built===3), aggregate tokens/cost, partial-failure keeps sibling + ok:false, no task/tasks rejects.
- self-review: each batch behavior has a failing-without-it test; no dead code; back-compat preserved
  (single path unchanged, details shape is mode-dependent); empty tasks falls through to single/reject.
COMMIT increment.

## Bring up to date on main
Merged origin/main (49 commits: rebrand, session-search, discord+slack gateway 0020-0023,
skill-capture 0024-0027, security-fence, cron) into feat/delegate-rpc (merge 066ceeb5f, clean,
no conflicts; extensions/index.ts auto-merged with both sides' extensions).
ADR collision: main already had ADR-0028-security-fence -> renumbered delegate ADR to
ADR-0029-delegate-tool (git mv + ref rewrite in handoff/summary/log). Verified on merged tree:
tsgo --noEmit clean, biome clean, delegate suite 30/1 green; main rpc.test.ts still uses
PI_CODING_AGENT_DIR (matches my live-gated test). Re-running full ./test.sh on the merged tree.
- Merged-tree full ./test.sh: coding-agent 14 failed / 4574 passed — the 14 are ONLY the documented
  sandbox known-fails (4603 x4, 4685 x9, daemon-serialized-refine x1); NO new failures. tui 758/0,
  ai 69, agent 315. The earlier kernel-agent-message-skill flake did not recur.
  Regression-free after the main merge.
