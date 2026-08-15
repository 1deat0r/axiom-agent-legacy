# Stale branches

This file is the policy for branches and worktrees that no one is working on.
The weekly hygiene sweep (ADR-0064) lists problems; this file says who cleans
them and how.

## Definitions

**Active branch.** A branch that an open issue references and that carries
commits not on main. Leave it alone.

**Stale branch.** A branch that meets one of:

- every commit on it is reachable from main (the work is merged, the branch
  survives as a label), or
- no open issue references it, or
- an open issue references it, but the branch is only behind main (main moved
  past it).

**Abandoned worktree.** A git worktree whose branch is stale and whose
checkout holds no uncommitted work.

## Who cleans

The agent that closed the issue owns the branch. When the issue is closed and
the audit comment is posted, the same agent deletes the branch and its
worktree in the same run. When the closing agent is gone, the next agent that
touches issue hygiene cleans it.

The weekly sweep never deletes branches, never closes issues, and never
merges. It lists; a human or an agent acts.

## How

Before deleting, prove the branch is stale. From the repo root:

```sh
git fetch origin "+refs/heads/*:refs/remotes/origin/*"
git log --oneline origin/main..origin/<name>   # empty = merged
git diff origin/main origin/<name> --stat      # empty = content reconciled
```

A branch whose diff is empty but whose commits are not ancestors of main
(example: content cherry-picked to main, branch left behind) is stale by
content. The diff is the proof, not the commit graph.

Delete a stale branch:

```sh
git branch -D <name>
git push origin --delete <name>
```

Delete an abandoned worktree:

```sh
git worktree remove <path>   # safe: fails when the checkout is dirty
git worktree prune
```

If `git worktree remove` refuses (dirty checkout), inspect the changes first.
Move anything valuable to its own branch or a file under docs/, then retry.

## The sweep's part

The sweep reports two shapes:

- **Unmerged branch.** An open issue references a branch with commits not on
  main. The issue owner reconciles: merge, or note why the branch lives.
- **Orphan branch.** Not reported today. A branch that no open issue
  references is invisible to the sweep by design (scope, ADR-0064). A future
  sweep can list orphans; until then, check with
  `git for-each-ref refs/remotes/origin/` when in doubt.
