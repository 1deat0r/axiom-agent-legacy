# Triage labels

This file is the single source of truth for the issue label vocabulary.
The repo uses ten labels in two families. Do not add labels that this file
does not define.

## Role family

Every issue has exactly one role label at all times. Set the role when you
create the issue.

| Label | Meaning | Set when |
| --- | --- | --- |
| `needs-triage` | A maintainer must evaluate the issue. | Default for new issues. The body does not meet the readiness contract. |
| `needs-info` | The issue waits for the reporter. | The body lacks facts that only the reporter knows. |
| `ready-for-agent` | An agent can do the work with no human in the loop. | The body meets the readiness contract below. |
| `ready-for-human` | A human must do the work. | The task needs credentials, hardware, or a decision that only a human can make. |
| `wontfix` | The team will not do the work. | The maintainer rejects the issue. |

## Readiness contract

An issue is ready-for-agent only when all five parts are present:

1. Goal. One sentence. States the outcome.
2. Acceptance criteria. A checklist. Each item must be verifiable.
3. Scope. Lists what the issue does not cover.
4. ADR status. States "ADR required" or "ADR not required". One capability, one ADR.
5. Verification plan. States how to prove the work. Red tests first. ./test.sh, biome, and tsgo clean.

If one part is absent, use `needs-triage` (or `needs-info` when the reporter
must add it).

## Wayfinder family

The wayfinder map protocol (issue-tracker.md) uses five labels:

| Label | Meaning |
| --- | --- |
| `wayfinder:map` | The single map issue that holds notes and decisions. |
| `wayfinder:research` | A child ticket for a research task. |
| `wayfinder:prototype` | A child ticket for a prototype. |
| `wayfinder:grilling` | A child ticket for a grilling run. |
| `wayfinder:task` | A child ticket for a plain task. |

## Automation

The workflow .github/workflows/triage.yml enforces two rules:

1. Open job. Fires on `opened`, `labeled`, and `unlabeled`. Zero role labels:
   apply `needs-triage` and post the contract (on `unlabeled`, post only — no
   re-apply, so a maintainer can switch roles without a fight; the remind
   comment says so). Two or more role labels: post a conflict note. One role
   label: no action. The job never comments on a closed issue, and it never
   posts a contract or remind comment that the bot already posted. A
   form-created issue fires two runs (opened and labeled); the second run is
   the echo of the first and posts nothing.
2. Close job. Fires on `closed`. When the issue closes without an audit
   comment, post one reminder. The audit comment must carry `Commit:`, `ADR:`,
   and `Handoff:` in one comment. The reminder does not repeat.

The close ritual applies to closes from ADR-0050 (2026-08-14) onward. Earlier
closes predate the policy and carry no audit comment by design.

3. Weekly sweep. `.github/workflows/issue-hygiene.yml` (ADR-0064) runs every
   Monday. It lists open issues with missing, conflicting, or unknown role
   labels, `needs-triage` issues older than seven days, and open issues that
   reference a branch with commits not on main. It posts one summary comment
   on the `HYGIENE_SUMMARY_ISSUE` issue and nothing when the problem set is
   unchanged. It never edits labels, never closes issues, never merges, never
   deletes branches.

Agents must still set the role at create and post the audit comment at close.
The workflow is the safety net, not the primary path.

## Drift checks

Two checks keep the live repo honest.

The live label set must match this file:

```
gh label list --limit 50
```

Fix drift with `gh label create` / `gh label delete`.

Closed issues from ADR-0050 onward must carry an audit comment. List the ones
that do not:

```
gh issue list --state closed --limit 1000 --json number,comments \
  --jq '[.[] | select((.comments | map(.body // "") | any(contains("Commit:") and contains("ADR:") and contains("Handoff:"))) | not) | .number]'
```

`--limit 1000` is the gh ceiling; the default page size is 30. A repo past
1000 closed issues needs a search-API sweep, not this command.

The list mixes two groups. Closes before 2026-08-14 are the 13 legacy
closes and are exempt. Closes from that date onward must carry an audit
comment; each one in the list that is not legacy is a live violation. Check
the close date with `gh issue view <number> --json closedAt`.

The contract tests in packages/coding-agent/test/gh-tooling/ guard the
templates and the workflow against the same vocabulary.
