# ADR-0060 — Provider-accurate tokenizers for the session token meter

## Status
Accepted (2026-08-15)

## Context
ADR-0055 made the session token meter the primary compaction trigger, but
its estimator is a fixed text density (one heuristic token per 4
characters plus block/role overhead) with no tokenizer. The ADR recorded
the follow-up explicitly: "a provider tokenizer is the recorded follow-up
for exactness". The density heuristic is directionally right but wrong in
both directions for real vocabularies: it undercounts CJK-heavy text
(cl100k_base prices one CJK character at up to 2 tokens, the heuristic at
0.25) and overcounts plain prose. The gateway knows the active
provider+model (the /model hotswap store, ADR-0033), so it can resolve the
right tokenizer without any provider API call.

## Decision
A provider-keyed tokenizer registry
(`src/gateway/tokenizer-registry.ts`) resolves the active provider+model
to a deterministic text counter; the meter
(`session-token-meter.ts`) prices the session surface with it:

- **gpt-tokenizer (pure JS) is the tokenizer engine.** The npm package
  `gpt-tokenizer` (3.4.0) is zero-dependency, and its BPE vocab tables
  (cl100k_base, o200k_base) ship as data modules inside the package, so
  counting needs no network and no native module. The coding-agent bundle
  inlines the tables at build time (esbuild; only native/interop-sensitive
  packages stay external), so the meter is offline-safe by construction —
  tables are npm-installed at build time, never fetched at runtime.
- **openai family** (openai, openai-codex, azure-openai-responses):
  o200k_base for the modern model families (gpt-4o*, gpt-4.1*, gpt-4.5*,
  gpt-5*, o1*, o3*, o4*, chatgpt-4o*), cl100k_base for the classic
  families (gpt-4*, gpt-3.5*, text-embedding*). A model-less resolution
  defaults to o200k_base (the current default family); an unrecognized
  model id counts on the denser cl100k_base table so an unknown model can
  never under-price a session.
- **deepseek: cl100k_base for every model.** DeepSeek publishes no
  official tokenizer package. Its tokenizer is a ~100k-vocab BPE in the
  GPT-4 family, and the cl100k_base count is the closest published
  pure-JS vocabulary — the best available approximation, adopted as-is.
  This is a stated approximation, not a claim of exact billing parity.
- **Fallback with warning.** A provider without a registered tokenizer
  falls back to the ADR-0055 heuristic, and the snapshot records a
  `fallbackWarning`; a console warning is emitted once per unknown
  provider per process so a gateway message loop cannot spam the log. A
  missing provider (the meter called without model context) stays on the
  heuristic silently — the meter is provider-agnostic when nothing is
  anchored.
- **The meter threads the context.** `measureSessionTokens(path,
  options?)` and `sessionExceedsTokenBudget(path, budget?, options?)`
  accept `{provider, model, tokenizer}` (an explicit tokenizer wins over
  provider resolution). The gateway hoists the active-model load and
  passes it into the token-pressure check, so a deepseek/openai channel
  prices on real tokens while a gateway without a stored model behaves
  exactly as before (heuristic).
- **Reference-graded eval.** Tests hardcode token counts for
  representative strings (prose, code, CJK+emoji, diacritics) verified
  against OpenAI's official tiktoken encodings on 2026-08-15, so the eval
  grades the tokenizer against an independent source instead of trusting
  gpt-tokenizer to grade itself. A comparison suite asserts the real
  count diverges from the density heuristic in the documented directions
  (higher for code/CJK, lower for plain prose), and a gateway integration
  test proves a session that prices under budget heuristically but over
  budget on cl100k_base requests compaction only when a deepseek model is
  active.

## Consequences
- Compaction pricing matches provider billing much more closely for
  openai and deepseek channels; CJK-heavy sessions now trigger compaction
  when they should (the density heuristic under-priced them by ~8x on
  CJK), and plain-prose sessions trigger slightly later.
- The gateway pays a real BPE pass per message instead of a string length
  check; measured at ~10ms for a budget-scale 190KB session, which is
  negligible against the reply latency the check exists to prevent.
- Snapshot shape widens: `estimator` is now a tokenizer name union,
  `charsPerToken` is present for heuristic counts only, and
  `fallbackWarning` appears on fallback counts. No consumer reads these
  fields today except tests.
- One new npm dependency (`gpt-tokenizer`, zero transitive deps). The
  meter stays offline: no runtime fetch, no native module.
- Providers other than openai/deepseek (anthropic, google, mistral, ...)
  still price under the heuristic with a one-per-process warning;
  registering a real tokenizer for one of them is a drop-in addition to
  the registry, keyed by provider id.
