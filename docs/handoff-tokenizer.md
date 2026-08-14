# Handoff: Provider-accurate tokenizers for the session token meter (ADR-0060, issue #38)

**Branch:** feat/tokenizer-real
**Date:** 2026-08-15
**State:** implemented, tested, ready for review

## What was built

The ADR-0055 session token meter priced the model-facing surface of a
channel session with a fixed text density (one heuristic token per 4
characters plus block/role overhead). This change replaces the density with
real tokenizers resolved per provider/model family.

- `packages/coding-agent/src/gateway/tokenizer-registry.ts` (new):
  `resolveTokenizer(provider?, model?)` returns a deterministic text counter
  keyed by provider family. openai (+ openai-codex, azure-openai-responses)
  maps modern model families (gpt-4o*, gpt-4.1*, gpt-4.5*, gpt-5*, o1*, o3*,
  o4*, chatgpt-4o*) to gpt-tokenizer's o200k_base and classic families to
  cl100k_base; a model-less openai resolution defaults to o200k_base, an
  unrecognized model id counts on cl100k_base (the denser table). deepseek
  resolves every model to cl100k_base — the stated approximation, since
  DeepSeek publishes no official tokenizer package and its BPE is a
  GPT-4-shaped ~100k-vocab family (ADR-0060 records the choice). Any other
  provider falls back to the ADR-0055 heuristic with a snapshot warning and
  a console warning emitted once per unknown provider per process. No
  provider context at all keeps the heuristic silently (previous behavior).
- `packages/coding-agent/src/gateway/session-token-meter.ts`:
  `measureSessionTokens(path, options?)` and
  `sessionExceedsTokenBudget(path, budget?, options?)` accept
  `{provider, model, tokenizer}` (explicit tokenizer wins). The snapshot's
  `estimator` is now the tokenizer name; `charsPerToken` appears on
  heuristic counts only and `fallbackWarning` on fallback counts. The
  pricing walk (`estimateContentTokens`/`estimateMessageTokens`) takes an
  injectable text counter defaulting to the heuristic, so the no-options
  path is byte-for-byte the old behavior.
- `packages/coding-agent/src/gateway/gateway.ts`: the agent-run path hoists
  the active-model load and passes provider+model into the token-pressure
  check, so a channel with a stored deepseek/openai model prices on real
  tokens; a gateway without a stored model is unchanged.
- `packages/coding-agent/package.json` + root `package-lock.json`: new
  dependency `gpt-tokenizer@^3.4.0` (zero transitive deps, pure JS).
- Docs: ADR-0060, CONTEXT.md "Session token meter" term, and the stale
  "ADR-0052" references to the meter (in session-token-meter.ts,
  session-reset.ts, gateway.ts comment, meter test describe blocks)
  corrected to ADR-0055.

## Offline safety

gpt-tokenizer ships its BPE vocab tables as data modules inside the npm
package (no fetch, no http usage anywhere in the package); the coding-agent
esbuild bundle inlines them (only native/interop packages stay external),
so tables are npm-installed at build time and never fetched at runtime.
Measured cost: ~10ms to encode a budget-scale 190KB session.

## What was verified and how

- **Red-first (unit):** `test/gateway/tokenizer-real.test.ts` failed on the
  pre-change code (missing `tokenizer-registry` module, 0 tests run), then
  24/24 green after the implementation.
- **Reference-graded eval:** token counts hardcoded in the tests were
  verified against OpenAI's official tiktoken (cl100k_base + o200k_base)
  on 2026-08-15 — prose 10/10, CJK+emoji 12/8, code 28/28, diacritics 7/6.
  gpt-tokenizer matches every reference exactly.
- **Comparison vs old estimator:** code-heavy transcript prices higher on
  the real tokenizer, plain prose lower, CJK-heavy sharply higher (>4x) —
  the documented divergence directions.
- **Gateway integration:** a CJK-dense session that the heuristic prices
  under `GATEWAY_SESSION_TOKEN_BUDGET` but cl100k_base prices over it
  requests `compactBefore` only when a deepseek model is active in the
  model store; without a stored model it does not.
- **Targeted suites:** tokenizer-real 24/24, session-token-meter 20/20,
  session-reset + gateway 44/44. biome clean on changed files; `tsgo
  --noEmit` clean.
- **Bundle/offline (real-environment):** the coding-agent build ran in this
  worktree; `dist/bundle/` inlines the gpt-tokenizer vocab tables (the only
  package references left are source-map path comments), and the bundled
  CLI boots (exit 0, prints usage) with `node_modules/gpt-tokenizer`
  removed entirely — the tables are npm-installed at build time, never
  fetched at runtime.
- **Not run here:** the full `./test.sh` floor (the parent runs it at merge
  time). The parent should run `npm install` in the shared tree before the
  floor so gpt-tokenizer resolves there, and rebuild dist after the merge
  (standard post-merge step).

## Follow-ups (recorded, out of scope)

- Register real tokenizers for other providers (anthropic, google, ...) —
  a drop-in registry entry each.
- The system-prompt envelope stays unpriced (recorded in ADR-0055);
  incremental sync from the snapshot `revision` is still the recorded
  follow-up if the per-message BPE pass ever shows in profiles.
