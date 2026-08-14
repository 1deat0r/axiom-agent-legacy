# Handoff — delegate Ralph handoff: a bounded structured result for helper sessions (issue #33)

Branch: `feat/delegate-ralph` (isolated worktree `.worktrees/issue-33-delegate-ralph`).
Base: `origin/main` @ `a384f4ed9` (peers fast path merge).
ADR: ADR-0054. Issue: #33.

## What was done

The delegate result now carries the Ralph handoff — the bounded structured report a
helper ends its run with, so a fresh child session hands its state back to the parent
without a transcript (the Ralph loop pattern from the deepseek-harness knowledge graph:
status, summary, evidence, next steps, blockers).

1. **Type** (`packages/coding-agent/src/extensions/delegate/types.ts`): new
   `DelegateHandoff` with the five fields; `DelegateResult` gains optional `handoff?`.
   The old compact result shape is untouched.
2. **New pure module** (`src/extensions/delegate/handoff.ts`):
   - `buildHelperPrompt(task)` — the task plus a required-handoff instruction (five
     fields as a JSON object last in the reply).
   - `parseDelegateHandoff(text, caps?)` — recovers the handoff with the
     battle-tested `extractJsonObject` from core/refinement (bare JSON, fenced
     ```json block, or JSON wrapped in prose); accepts `next_steps`; wraps
     single-string lists; returns `undefined` when there is no handoff.
   - `capHandoff` + `DEFAULT_HANDOFF_CAPS` — status 100, summary 2000 (pinned equal
     to `DEFAULT_SUMMARY_MAX_CHARS`), evidence <=8 x 500, next steps <=8 x 300,
     blockers <=8 x 300; blanks dropped.
   - `renderHandoff` — compact parent-facing rendering.
3. **Wiring**:
   - `bridge.ts`: `createRpcClientBridge.runTask` sends `buildHelperPrompt(task)` to
     the helper process — every consumer (single, batch, background) asks for the
     handoff with no tool-contract change.
   - `index.ts` + `background.ts`: both run paths parse the helper's final text into
     the result; `toDelegateResult` attaches the handoff on ok results only and
     re-caps it at the contract boundary.
   - `result.ts`: `renderDelegateResult` renders the structured handoff when present
     (old summary text otherwise); `renderBatchResult` labels each delegation line
     with its handoff status, in input order.
4. **Docs**: ADR-0054, CONTEXT.md "Ralph handoff" term, this handoff.

## What was verified (unit / mock / live)

- **Red first**: the new suites failed against the absent `handoff.js` module
  (`Cannot find module '../../src/extensions/delegate/handoff.js'`), then went green
  after implementation.
- **Unit/mock**: 21 new tests in `test/extensions/delegate.test.ts` —
  `buildHelperPrompt` keeps the task and names the five fields + JSON;
  `parseDelegateHandoff` (bare/fenced/prose-wrapped JSON, snake_case `next_steps`,
  single-string wrapping, no-JSON and no-handoff-field -> undefined);
  `capHandoff` (every field capped, blanks dropped, summary cap aligned with the
  compact result); `toDelegateResult` (attaches, boundary-caps, never attaches to
  failures); tool wiring (single task attaches the parsed handoff while the summary
  keeps the raw text, old compact result byte-identical without a handoff, batch
  handoffs aggregate in input order with status labels, background result file
  carries the handoff); `renderBatchResult` order. Suite result: 63 passed,
  1 skipped (live-gated).
- **Live (real process, mock protocol)**: one probe test spawns the genuine
  `createRpcClientBridge` against a fake helper process and asserts the exact prompt
  the helper received equals `buildHelperPrompt("tidy the repo")` — proving the real
  bridge asks the helper for the handoff, not just the stub path.
- **Full suite**: `./test.sh` (with `AXIOM_PROJECT_ROOT` unset) — see the issue
  comment for the floor numbers; the only failures are the documented sandbox
  known-fails (EXDEV hard-link suites, daemon-serialized-refine).
- **Static**: `npx biome check .` and `tsgo --noEmit` (in packages/coding-agent)
  clean.

## Honest limits

- The real-model path (live-gated `delegate real bridge`) is skipped in the neutral
  suite (no API keys in the sandbox); the prompt is verified via the probe process.
- `extractJsonObject` slices from the first `{` to the last `}`, so a helper reply
  containing an earlier JSON object plus the handoff at the end can fail to parse;
  the fallback is the old compact summary (recorded in ADR-0054).
- Out of scope by issue: gateway fresh-session rounds, remote subagent backends,
  helper model selection, the workflow tool.
