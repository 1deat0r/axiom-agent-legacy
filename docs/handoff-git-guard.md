# Handoff: git guard (ADR-0048)

## What was done

- Added the git-guard extension (src/extensions/git-guard/): pure matcher
  (guard.ts) and tool_call wiring (index.ts), shipped in builtInExtensions.
- It blocks destructive git commands from the agent's bash and ipython tools on
  anchored runs: push (all forms), reset --hard, clean -f variants, branch -D,
  checkout ., restore .
- Inert unless anchored (AXIOM_PROJECT_ROOT), mirror of the security fence.
- Escape: AXIOM_GIT_GUARD_ALLOW (exact command strings). The operator's own
  terminal and user_bash commands are never guarded.

## What was verified

- 44 new tests red-first, then green (test/extensions/git-guard.test.ts):
  matcher blocks each dangerous form, allows safe commands, honors allowExact
  and extraPatterns; wiring blocks anchored bash/ipython calls, is inert
  without a root, leaves other tools alone.
- Extension suites: 17 files, 286 passed, 1 skipped, no regressions.
- biome check clean on all touched files. tsgo --noEmit exit 0.

## How (unit / mock / live)

- Unit and wiring tests only (mock ExtensionAPI, same pattern as the security
  fence). No live run: the guard activates on anchored completions; a live
  smoke with a real anchored agent run is the operator-gated follow-up.
