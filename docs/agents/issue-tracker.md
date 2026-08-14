# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all
operations.

> **gh repo default (2026-08-12):** this repo has an `upstream` remote
> (PrimeIntellect-ai/axiom, ADR-0015). `gh` resolves the repo from the branch's
> upstream, then falls back to remotes — a branch with no tracking upstream
> resolves to `upstream` (the pi repo). Fixed in this checkout via
> `gh repo set-default mustbearnold/axiom-agent` and per-branch upstream
> tracking. If a fresh checkout misbehaves, re-run
> `gh repo set-default mustbearnold/axiom-agent` (or pass `-R` explicitly).

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
ADR: docs/adr/00XX-<slug>.md (or: not required)

> **ADR reservation rule:** an issue that needs an ADR claims the number at
> create time, in the title (`(ADR-00NN)`): the LOWEST number no ADR file in
> `docs/adr/` holds and no other OPEN issue reserves. Allocation happens in
> the tracker, never at branch time — parallel branches cannot see each
> other's ADR files, so first-write-wins collides (observed 0047, 0048,
> 0067). At merge, the merging agent verifies the ADR file's number equals
> the issue's reservation; on collision, renumber the LATER reservation
> (rename the file, fix the title and all references) and note it on the
> issue.
Handoff: docs/handoff-<feature>.md
Verified: <what you ran and what passed>
EOF
)"
gh issue close <number>
```

A close with no code (a bookkeeping close, a superseded plan, a self-test)
uses the not-applicable form. State the reason. Never leave a line blank:

```
Commit: not required (<reason>)
ADR: docs/adr/00XX-<slug>.md (or: not required (<reason>))
Handoff: not required (<reason>)
Verified: <what you checked and what you found>
```

The audit comment is the trail from issue to code to decision to proof. Do not
skip it.

## Automation

The workflow `.github/workflows/triage.yml` is the safety net. It has two jobs:

1. Open job. Fires on `opened`, `labeled`, and `unlabeled`. Zero role labels:
   apply `needs-triage` and post the contract (on `unlabeled`, post only; the
   remind comment says the workflow does not re-apply). Two or more role
   labels: post a conflict note. One role label: no action. The job never
   comments on a closed issue and never reposts a comment the bot already
   made. A form-created issue fires two runs (opened and labeled); the second
   run posts nothing.
2. Close job. Fires on `closed`. When the issue closes without an audit
   comment, post one reminder. The audit comment must carry `Commit:`, `ADR:`,
   and `Handoff:` in one comment. The reminder does not repeat.

The close ritual applies to closes from ADR-0050 (2026-08-14) onward. Earlier
closes predate the policy.

Agents must still set the role at create and post the audit comment at close.
Do not rely on the safety net.

A third workflow, `.github/workflows/issue-hygiene.yml`, sweeps weekly
(ADR-0064). It posts one summary comment on the issue named by the
`HYGIENE_SUMMARY_ISSUE` repository variable when open issues drift (labels,
stale `needs-triage`, unmerged branches). Branch cleanup follows
[docs/agents/stale-branches.md](stale-branches.md).

To test the classifier locally:

```
echo '{"labels":[]}' | npx tsx packages/coding-agent/src/core/gh-tooling/triage-cli.ts
```

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
