# Handoff: feat/root-guard-final — merge main into root guard (issue #17)

**Date:** 2026-08-14
**Branch:** feat/root-guard-final (merge commit 8d5553b60)
**Issue:** #17 (Anti-drift root guard, ADR-0052)

## What was done

Merged origin/main (473516062, 18 commits) into feat/root-guard-final
(cf7883d3c, review round 10) with a no-ff merge commit. The branch carries
15 commits of root-guard work on top of the merge.

One conflict, resolved additively: `packages/coding-agent/src/extensions/index.ts`.
Main added the schedule extension (axiomScheduleExtension import + built-in
entry); the branch added the root guard (axiomRootGuardExtension). Both kept,
root-guard placed before schedule in import order and list order.

All other files auto-merged cleanly, including main.ts (root-guard command
dispatch intact), command-registry.ts (root-guard and schedule entries both
present), CONTEXT.md (Root guard and Schedule tools terms both present), and
test.sh (root-guard env scrub intact on top of main's scrub block).

## Verification

- Floor on the merged tree (`./test.sh`): 5339 passed / 16 failed.
  - 14 documented sandbox known-fails: daemon-serialized-refine x1,
    4603-worker-recovery x4, 4685-daemon-client-modes x9 (EXDEV hard-link
    layout).
  - 2 real-kernel flakes that pass standalone: kernel-agent-message-skill
    (7/7), kernel-attach-image-skill (9/9). Same flake pattern as documented
    for this suite under parallel load.
- Root-guard suites on the merged tree: 100/100 (root-guard, root-guard-command,
  root-guard-paths, root-guard-scope, root-guard-store, workspace).
- `tsgo --noEmit` clean. `npx biome check .` clean (2 pre-existing infos).

## Acceptance re-check (issue #17)

All five boxes re-verified against the merged code. None regressed:

1. Block-by-default outside the root: the gate blocks bash/ipython path
   tokens outside AXIOM_PROJECT_ROOT; INFRA_ALLOW_PREFIXES remains opt-in via
   AXIOM_ROOT_GUARD_ALLOW (tests: strict posture, opt-in infra list).
2. Plain-English approval: request_root_access tool (registered only when
   anchored), CLI `axiom root-guard approve|reject|list`, append-only audit
   JSONL covering block/request/decision/grant/grant-use.
3. No new dependencies: no package.json or lockfile changes on the branch;
   built on the existing tool_call seam (ADR-0028 pattern).
4. Unanchored runs inert: factory returns early without a project root;
   test "is inert without a project root" green.
5. Red-first tests and the floor above.

## Worktree environment note (important for review)

/tmp worktrees with a symlinked node_modules fail spuriously in this sandbox:
vitest resolves the bare builtin `stream` to
`<packages/coding-agent>/stream` and errors with ERR_MODULE_NOT_FOUND,
failing 112 suites. The shared tree and this worktree with a real node_modules
copy both pass. This worktree therefore carries a real node_modules copy
(not a symlink) with these workspace symlinks re-pointed to the shared tree's
built packages (which have dist/):

  node_modules/@earendil-works/{pi-ai,pi-agent-core,pi-coding-agent,pi-tui}
  and their .pi-*-hash variants -> /home/mustbearn/Projects/axiom-agent/packages/*

Do not restore the node_modules symlink before running the floor here.

## Not done / follow-ups

- Parent performs the independent review and the merge to main (not done here).
- Gateway inline approval buttons remain a recorded follow-up (ADR-0052).
