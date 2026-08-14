# Handoff — write tool (issue #46, ADR-0068)

## What was done

Added the `write` core tool: `src/core/tools/write.ts` (factory + definition +
injectable `WriteOperations`), registered in `core/tools/index.ts`, active by
default (`core/agent-session.ts` and `core/sdk.ts`), exported from
`core/sdk.ts` and the package index, and accepted by the CLI (`src/cli/args.ts`).
Branch stacks on `feat/read-tool` (8934f8806).

## What was verified and how

- **Eval (unit):** `test/write-tool.test.ts` (17 cases) plus the five write
  cases of `test/read-write-threat-corpus.test.ts`, written first and red
  (import failures plus updated 4428/args regression assertions), then green
  after implementation. 234 targeted tests green including read-tool,
  system-prompt, and tools suites.
- **Type/lint:** `tsgo --noEmit` clean; biome clean after format pass.
- **Full floor:** deferred to the merge gate per the review rubric.

## Notes for the reviewer

- Review scope is the delta against `feat/read-tool` (the read tool reviewed
  separately as issue #45).
- The safety-critical lines: O_EXCL create, temp-plus-rename overwrite,
  symlink replace semantics, and the mutation-queue wrapping.
- One test expectation needed a fix during development: the shared
  `generateDiffString` emits numbered lines (`-2 remove`), not bare markers.
