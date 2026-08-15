# File-system search tools (grep tool + ast-grep skill)

Issue #49, ADR-0073, 2026-08-15.

## What

- New built-in `grep` tool (packages/coding-agent/src/core/tools/grep.ts):
  ripgrep wrapper with `files` mode (paths sorted by mtime, Codex-style) and
  `content` mode (path:line: text, OpenCode-style), gitignore-aware, capped
  (limit 100/2000, 500-char lines, 50KB text), clear errors, injectable
  operations, `--sortr` fallback for ripgrep < 14.
- Registration: `core/tools/index.ts` (ToolName), `cli/args.ts` (built-in
  again; `find`/`ls` stay removed), default active tools in `sdk.ts`, TUI
  replay case in `tool-execution.ts`.
- New `ast-grep` skill (packages/coding-agent/skills/ast-grep/SKILL.md):
  structural search recipes (definitions, call sites, instantiations) and
  the grep-vs-ast-grep choice rule. Passes `axiom skill-check --strict`.
- Regression tests updated: #4428 (built-in set), #3592 (registry list),
  args tests (grep accepted, find/ls rejected).

## Verification

- New: test/tools/grep.test.ts, 15 tests red-first (fake-ops unit coverage
  plus a live ripgrep test that skips when `rg` is absent).
- Full floor: ./test.sh, biome, tsgo (recorded in the handoff).
