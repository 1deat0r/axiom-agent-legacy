# ADR-0048: Git guard (destructive-git block on shell tool calls)

**Status:** accepted
**Date:** 2026-08-14
**Extends:** ADR-0018 (workspace root guard), ADR-0014 (anti-drift ladder), ADR-0028 (security fence seam)
**Adapts:** the `git-guardrails` agent skill (Claude Code PreToolUse hook) to Axiom's `tool_call` seam

## Context

The repo runs parallel anchored agent sessions that share one working tree
(ADR-0038 peer coordination). Destructive git commands from one agent can wipe
other work: past sessions saw a merge operation erase uncommitted edits in the
shared tree, and stray files land from a neighboring session. The
`git-guardrails` skill blocks the common destructive forms (push, reset --hard,
clean -f, branch -D, checkout/restore ".") with a PreToolUse hook in Claude
Code. Axiom has no Claude Code hooks; its equivalent seam is the `tool_call`
extension event (agent-session `beforeToolCall`), which can `block` a tool call
with a `reason` surfaced to the model - the same seam ADR-0028's fence uses.

ADR-0018/ADR-0019 hold that `bash`/`ipython` are freeform and cannot be
string-confined. This guard is NOT confinement and claims nothing more: it is a
conservative best-effort block of the common accidental destructive forms, in
the same belt-and-suspenders spirit as the root guard.

## Decision

A **git guard extension** (`packages/coding-agent/src/extensions/git-guard/`,
shipped in the axiom built-ins) that is **inert unless a run is anchored** - the
same gating as the security fence. On an anchored run its `tool_call` handler
scans the freeform shell tools (`bash` input.command, `ipython` input.code)
with `checkGitCommand` (pure, `guard.ts`):

- `DEFAULT_GIT_GUARD_PATTERNS` - a port of the skill's blocklist: `git push`
  (all forms incl. `--force`/`--force-with-lease`), `git reset --hard`,
  `git clean` with an `-f` flag or `--force`, `git branch -D`,
  `git checkout .`/`-- .`, `git restore .`/`-- .`.
- Whole-text regex matching (conservative, like the skill's grep): prose or
  scripts that merely contain `git push` are blocked; the model rewords.
- A blocked call returns `{ block: true, reason }` naming the pattern and the
  escape hatch: `AXIOM_GIT_GUARD_ALLOW` (comma-separated EXACT command strings)
  or the operator's own terminal.
- `extraPatterns` and `allowExact` are injectable via options for tests and
  per-project tuning.

The operator's own `user_bash` (!) commands are never guarded - the guard lives
on the agent tool seam, not on the human.

## Consequences

- Anchored agent runs can no longer push, hard-reset, force-clean, force-delete
  branches, or discard working-tree edits by accident. The operator approves an
  exact command via `AXIOM_GIT_GUARD_ALLOW` when a push is genuinely wanted.
- Honest boundary (recorded, not faked): string matching is not confinement.
  Reworded or aliased invocations (`git --no-pager push`, absolute-path git,
  shell aliases, scripts) pass through. The guard stops accidents, not
  adversaries - rung 3 of the ADR-0014 ladder stays best-effort by design.
- Whole-text matching is conservative and may block harmless prose in a shell
  cell; the reason message tells the model to reword.
- Unanchored `axiom` runs are untouched, matching the fence and root guard.

## Alternatives considered

- A PATH shim (git wrapper) at OS level: real enforcement, but it mutates the
  agent's environment at boot, is harder to wire into the already-running
  ipython kernel, and duplicates the blocklist in bash. Recorded as a follow-up
  if a stronger tier is ever wanted.
- Guarding `user_bash`: rejected - the operator has authority over their own
  shell.
