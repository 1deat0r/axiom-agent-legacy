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
