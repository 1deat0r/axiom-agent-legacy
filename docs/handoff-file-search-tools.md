# Handoff: file-system search tools (grep tool + ast-grep skill)

Issue #49, ADR-0073, branch feat/search-meta, 2026-08-15.

## What was done

- New built-in `grep` tool at packages/coding-agent/src/core/tools/grep.ts.
  Ripgrep wrapper with two modes per the 2026 agent-search meta:
  - files (default): `rg --files-with-matches --sortr=modified` — matching
    paths sorted by last-modified, Codex shape; falls back to unsorted rg
    output when the installed ripgrep is older than 14.0 (no --sortr) and
    notes it in details.
  - content: `rg --json` parsed into `path:line: text` lines with optional
    context (`path-line-` separators), OpenCode shape.
  - Shared behavior: gitignore-aware, caps (limit default 100 / max 2000,
    500-char lines, 50KB final text), clear errors (missing rg, missing
    path, bad regex), abort support, injectable GrepOperations + ensureRg
    so tests run without rg and remote adapters can replace local search.
- Registration: core/tools/index.ts (ToolName + factory switches), default
  active tools in sdk.ts, cli/args.ts (grep accepted again; find/ls stay
  removed), TUI replay case in tool-execution.ts.
- New ast-grep skill at packages/coding-agent/skills/ast-grep/SKILL.md:
  structural search recipes (definitions, call sites, instantiations) and
  the grep-vs-ast-grep choice rule. Passes axiom skill-check --strict.
- ADR-0073, CONTEXT.md "File search" term, feature-logs/file-search-tools.md.

## What was verified and how

- Red first: test/tools/grep.test.ts written before the tool existed; the
  file failed to load. After implementation: 15/15 green (fake-ops unit
  coverage + one live ripgrep test that skips when rg is absent).
- Updated suites green: 4428 regression 6/6, 3592 regression 3/3,
  args.test.ts 108/108.
- Full floor on the worktree: 5732 passed / 14 failed. The 14 failures are
  4603 x4 + 4685 x9 documented EXDEV known-fails (hard-link of the node
  binary across btrfs subvolumes; pass on normal filesystems) + 1
  kernel-rlm-heartbeat-skill flake that passes standalone 3/3.
- npx biome check . clean (3 pre-existing telegram-transport infos).
- npx tsgo --noEmit clean.
- axiom skill-check --strict on the ast-grep skill: OK (1 loaded).

## Not done (scope)

- No call-graph index (deferred in ADR-0073 as future work).
- No find/ls restore, no vector search.
- Not merged to main; issue #49 stays open until the merge ritual.
