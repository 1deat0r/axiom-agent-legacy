# Handoff — read tool (issue #45, ADR-0067)

## What was done

Added the `read` core tool: `src/core/tools/read.ts` (factory + definition +
injectable `ReadOperations`), registered in `core/tools/index.ts`
(`ToolName`, `allToolNames`, `createAllTools`, `createAllToolDefinitions`),
active by default (`core/agent-session.ts` `defaultActiveToolNames` and
`core/sdk.ts` `initialActiveToolNames`), exported from `core/sdk.ts` and the
package index, and accepted by the CLI (`src/cli/args.ts`).
`REMOVED_BUILTIN_TOOL_NAMES` now holds grep/find/ls only.

## What was verified and how

- **Eval (unit):** `test/read-tool.test.ts` (22 cases) and the five read cases
  of `test/read-write-threat-corpus.test.ts` were written first and failed
  (red: module absent + regression assertions updated in
  `4428-remove-legacy-pi-mono-tools.test.ts` and `args.test.ts`), then passed
  after the implementation (140 targeted tests green; 241 green including
  system-prompt and tool-execution suites; agent-session-runtime 27 green).
- **Type/lint:** `tsgo --noEmit` clean; biome clean after format pass.
- **Full floor:** not yet run on this branch; the merge gate (review rubric)
  runs `./test.sh` on the merged tree.

## Notes for the reviewer

- The hard 2MB cap and the stat-before-read gate are the safety-critical
  lines; the corpus cases R1-R5 encode them.
- `read` never writes; no file-mutation queue involvement.
- The stacked `feat/write-tool` branch builds on this tip.
