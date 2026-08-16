# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all
operations.

> **gh repo default (2026-08-16):** this repo tracks `upstream` =
> NousResearch/hermes-agent (ADR-0087) and publishes to `origin` =
> 1deat0r/axiom-agent. `gh` resolves the repo from the branch's upstream, then
> falls back to remotes — a branch with no tracking upstream could resolve to
> the Hermes upstream. Set the default explicitly so `gh` targets this repo:
> `gh repo set-default 1deat0r/axiom-agent`. If a fresh checkout misbehaves,
> re-run it (or pass `-R 1deat0r/axiom-agent` explicitly).

## TL;DR

- Create: `gh issue create --label <role> --title "..." --body-file body.md`
- Read: `gh issue view <number> --comments`
- Claim: `gh issue edit <number> --add-assignee @me`
- Close: post the audit comment, then `gh issue close <number>`

Every issue gets exactly one role label at create. The role vocabulary and the
readiness contract live in [triage-labels.md](triage-labels.md).

## Create

Rule: every issue gets exactly one role label in the create command. Pick
`ready-for-agent` only when the body meets the readiness contract
(triage-labels.md). When in doubt, use `needs-triage`.

Use the agent form for a task that follows the contract:

```
gh issue create --template agent-task
```

Use the bug form for a bug report:

```
gh issue create --template bug-report
```

Blank issues are off. The web UI offers only these two forms.

For a multi-line body, write the body to a file and pass `--body-file`.

## Conventions

- **Create an issue**: `gh issue create --label <role> --title "..." --body "..."`. Use a heredoc or `--body-file` for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`. Use `jq` to filter the comments and fetch the labels.
- **List issues**: `gh issue list --state open --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters. The default page size is 30; pass `--limit` or `--paginate` for older issues.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run
inside a clone.

## Close ritual

Never close an issue without an audit comment. The comment links three
artifacts:

- the merge commit (or the final commit hash)
- the ADR file (when the work required one)
- the handoff doc

Template:

```
gh issue comment <number> --body "$(cat <<'EOF'
Landed.

Commit: <hash>
ADR: axiom/docs/adr/00XX-<slug>.md (or: not required)

> **ADR reservation rule:** an issue that needs an ADR claims the number at
> create time, in the title (`(ADR-00NN)`): the LOWEST number no ADR file in
> `axiom/docs/adr/` holds and no other OPEN issue reserves. Allocation happens in
> the tracker, never at branch time — parallel branches cannot see each
> other's ADR files, so first-write-wins collides (observed 0047, 0048,
> 0067). At merge, the merging agent verifies the ADR file's number equals
> the issue's reservation; on collision, renumber the LATER reservation
> (rename the file, fix the title and all references) and note it on the
> issue.
Handoff: axiom/docs/handoff-<feature>.md
Verified: <what you ran and what passed>
EOF
)"
gh issue close <number>
```

A close with no code (a bookkeeping close, a superseded plan, a self-test)
uses the not-applicable form. State the reason. Never leave a line blank:

```
Commit: not required (<reason>)
ADR: axiom/docs/adr/00XX-<slug>.md (or: not required (<reason>))
Handoff: not required (<reason>)
Verified: <what you checked and what you found>
```

The audit comment is the trail from issue to code to decision to proof. Do not
skip it.

## Automation

Ported 2026-08-16 (session 8, issue #66). The `.github/workflows/triage.yml`
and `.github/workflows/issue-hygiene.yml` operators run on this baseline,
re-pointed at `axiom/gh-tooling/src/*.ts` (ported from the prime-era
`packages/coding-agent/src/core/gh-tooling/`, zero runtime deps beyond `tsx`).
They sit alongside the 27 upstream Hermes workflows.

- `triage.yml` — on issue open/close/label/unlabel: applies `needs-triage`
  and posts the readiness contract on zero-role-label opens, flags role
  conflicts, and posts one close-ritual nudge when an issue closes without
  an audit comment.
- `issue-hygiene.yml` — weekly (Mon 03:23) + `workflow_dispatch`: sweeps
  open issues for missing/conflicting/unknown labels, stale `needs-triage`,
  and unmerged branches referenced by open issues; posts a summary to the
  `HYGIENE_SUMMARY_ISSUE` repo var when set, deduplicated by fingerprint.

Activation was operator-gated and is now COMPLETE (session 9):

1. GitHub Actions is enabled on the fork (`actions/permissions` →
   `enabled: true`).
2. `HYGIENE_SUMMARY_ISSUE` is set to `67` — the open ledger issue that
   receives the weekly summary comment (a passive record, not a ticket).

Both operators are live: `Issue triage` (on open/close/label/unlabel) and
`Issue hygiene sweep` (weekly Mon 03:23 + `workflow_dispatch`). The
role-label + audit-comment discipline is now CI-enforced in addition to the
agent-enforced practice: set the role at create and post the audit comment at
close.

## Labels

The live label set must match the vocabulary in triage-labels.md: five role
labels, five wayfinder labels, no others. Fix drift with `gh label create` /
`gh label delete`.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external
PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using
the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be
either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as
tickets. The wayfinder label family is pre-created on the repo
(triage-labels.md).

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues are not enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blockers**: GitHub's **native issue dependencies** are the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies are not available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
