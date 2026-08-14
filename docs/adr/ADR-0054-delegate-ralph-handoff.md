# ADR-0054: Delegate Ralph handoff — a bounded structured result for helper sessions

- Status: accepted
- Date: 2026-08-14
- Branch: feat/delegate-ralph
- Related: ADR-0029 (delegate tool), ADR-0044 (background delegate), issue #33

## Context

The Ralph loop (deepseek-harness research, the "Ralph loop" concept in its knowledge
graph): one foreground fresh-agent workflow run toward an immutable objective, where
each round is a fresh child session and a bounded structured handoff plus a shared
workspace carry state between rounds. Because every round starts fresh, the handoff is
the only thing that carries the previous round's state — so it must be bounded (never
a transcript) and structured (the next round must be able to consume it).

Axiom's delegate tool (ADR-0029) is already one round of that shape: a fresh helper
process collapses a multi-step job into a compact block
`{ok, summary, tokens, cost, helper?, error?}`. But the block's only content is the raw
summary: the parent cannot tell from the result what was actually verified, what
remains, and what blocks completion. In practice the operator works around this with
hand-written handoffs and fresh worktrees; the parent integrates by re-reading state.

This ADR formalizes the pattern as the delegate result contract: the helper is asked
to end its run with the Ralph handoff, and the delegate result carries it.

## Decision

Add the Ralph handoff to the delegate result as an optional, capped structured block.

1. **Type** (`types.ts`): `DelegateHandoff` with five fields — `status` (done, partial,
   blocked, failed), `summary`, `evidence[]`, `nextSteps[]`, `blockers[]`.
   `DelegateResult` gains an optional `handoff?`; the old compact result shape is
   untouched.
2. **Prompt** (`handoff.ts` + `bridge.ts`): `buildHelperPrompt(task)` keeps the task
   verbatim and appends a required-handoff instruction — the five fields as a JSON
   object placed last in the final reply. `createRpcClientBridge.runTask` sends the
   wrapped prompt, so every consumer (single, batch, background) asks for the handoff
   with no change to the tool contract (`runTask(task)` still takes the raw task).
3. **Parse** (`handoff.ts`): `parseDelegateHandoff` reuses the battle-tested
   `extractJsonObject` from core/refinement (bare object, fenced ```json block, or
   JSON wrapped in prose), accepts `next_steps` as well as `nextSteps`, wraps
   single-string evidence/next-steps/blockers into arrays, and returns `undefined`
   when the helper emitted no handoff — the old compact result stays the fallback.
4. **Caps** (`handoff.ts`): `DEFAULT_HANDOFF_CAPS` — status 100 chars, summary 2000
   chars (= `DEFAULT_SUMMARY_MAX_CHARS`, pinned by a test), evidence at most 8 items x
   500 chars, next steps at most 8 x 300, blockers at most 8 x 300. `capHandoff`
   applies at parse time and again at the `toDelegateResult` boundary, so no producer
   can leak an oversized field.
5. **Batch**: `mapWithConcurrency` already preserves input order, so per-delegation
   handoffs aggregate in order; `renderBatchResult` labels each line with its handoff
   status (`- [done] ...`, `- [blocked] ...`).
6. **Rendering** (`result.ts`): `renderDelegateResult` renders the structured handoff
   when present and falls back to the old summary text otherwise; the compact
   `summary` field itself is unchanged (still the capped raw closing text).
7. **Background** (`background.ts`): the `_run` path parses the handoff exactly like
   the blocking path, so the result file carries the same structured block.

## Consequences

- Bounded: every handoff field is length-capped, so a helper cannot grow the parent
  context beyond the caps no matter what it returns.
- Backwards compatible: helpers that emit no handoff produce exactly the old compact
  result; all pre-existing delegate behavior and tests are unchanged.
- The summary still carries the raw final text (including the handoff JSON when the
  helper ends with one); the handoff is the structured, capped projection of it.
- Parsing is best-effort: a malformed or missing JSON tail yields no handoff, never a
  failed delegation — the old summary is the fallback.
- `extractJsonObject` slices from the first `{` to the last `}`, so a helper reply
  that contains an earlier JSON object plus the handoff at the end can fail to parse.
  Acceptable: the fallback is the old compact result. A last-JSON-object scan is a
  recorded follow-up if it ever matters.

## Follow-ups (out of scope, per issue #33)

- Fresh-session rounds in the gateway (the Ralph loop driver).
- Remote subagent backends, helper model selection, and the workflow tool.
