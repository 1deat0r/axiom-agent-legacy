# Handoff: gateway session token meter (issue #31)

Branch `feat/token-meter` (isolated worktree `.worktrees/issue-31-token-meter`,
cut from origin/main = a384f4ed9). ADR-0055.

## What was done

The gateway compacted sessions on file bytes (ADR-0041). The token meter
measures the model-facing surface instead, and token pressure becomes the
primary compaction trigger while the byte budget stays as the safety limit.

1. `src/gateway/session-token-meter.ts` (new): a deterministic,
   tokenizer-free estimator (one heuristic token per 4 characters,
   `CHARS_PER_TOKEN`; `BLOCK_OVERHEAD` and `ROLE_OVERHEAD` structural
   overheads) that prices text/thinking/toolCall/toolResult blocks and
   falls back to a conservative JSON price for unknown block types;
   `estimateTextTokens`/`estimateContentTokens`/`estimateMessageTokens`.
2. `measureSessionTokens(path)` reads the session JSONL once and prices
   every `message` entry (the model-facing surface); session metadata
   entries price nothing. It returns a frozen `TokenMeterSnapshot` with
   `revision` (entries consumed), `estimator`, `charsPerToken`,
   `surfaceTokens`, `pricedMessages`, `malformedEntries`. Malformed lines
   are skipped and counted; missing or unreadable files measure as a zero
   snapshot so the check never blocks a reply.
3. `GATEWAY_SESSION_TOKEN_BUDGET` (48 * 1024 heuristic tokens) with pure
   predicate `exceedsTokenBudget(snapshot, budget)` and file convenience
   `sessionExceedsTokenBudget(path, budget?)` (never-block contract, mirror
   of `sessionExceedsBudget`).
4. `gateway.ts`: the compaction trigger is now
   `sessionExceedsTokenBudget(path) || sessionExceedsBudget(path)` -
   token pressure primary, byte budget as the OR safety limit. The
   `compactBefore` flag, archive behavior, `/search`, and the compaction
   summary text are unchanged.
5. `session-reset.ts`: docstring cross-references the token meter as the
   primary trigger; the byte budget semantics did not change.

## What was verified

- **Unit (red-first).** 20 new tests in
  `test/gateway/session-token-meter.test.ts`, written before the module
  existed (confirmed red: `Cannot find module
  ../../src/gateway/session-token-meter.js`), then green: estimator pricing
  (text/thinking/toolCall/toolResult/unknown blocks, role overhead,
  determinism), snapshot semantics (missing file, unreadable directory,
  message-only pricing, revision counts, malformed-line skip-and-count,
  trailing newline, frozen + mutation throws, toolResult entry pricing),
  budget predicate boundary, and gateway trigger tests. The key trigger
  test proves a token-heavy session whose file stays under
  `GATEWAY_SESSION_BUDGET_BYTES` flags `compactBefore: true`, a token-light
  session does not, and a byte-heavy session the meter prices at zero still
  compacts through the byte safety limit. 20/20 pass.
- **Regression.** `test/gateway/gateway.test.ts` 44/44 (the ADR-0041 byte
  path and the ADR-0050 retry tests still pass unchanged).
- **Floor.** Full `./test.sh` from the worktree root with
  `AXIOM_PROJECT_ROOT` unset: 5176 passed / 14 failed / 60 skipped (5250
  tests; 383 files passed / 3 failed / 8 skipped). The 14 failures are
  exactly the documented sandbox known-fails (daemon-serialized-refine x1,
  4603-worker-recovery x4, 4685-daemon-client-modes x9), all EXDEV
  cross-device hard-link failures from the btrfs subvolume layout; no new
  or unexpected failure. `test/gateway/session-token-meter.test.ts` ran
  inside the floor (20 tests, 124ms).
- `npx biome check .` clean, `npx tsgo --noEmit` clean (packages/coding-agent).

## Honest limits (recorded follow-ups in ADR-0055)

- The meter prices only the session message surface; the system-prompt
  envelope is not visible to the gateway and stays unpriced.
- The estimator is a fixed-density heuristic, not a provider tokenizer;
  the byte budget covers the undercount side.
- The gateway reads the whole session JSONL per reply (same O(file) class
  the completion child already pays); incremental sync from `revision` is
  the follow-up if it ever shows in profiles.
