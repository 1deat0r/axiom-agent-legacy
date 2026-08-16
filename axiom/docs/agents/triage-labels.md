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

Ported 2026-08-16 (session 8, issue #66). The `.github/workflows/triage.yml`
(ADR-0050) and `.github/workflows/issue-hygiene.yml` (ADR-0064) operators run
on this baseline, re-pointed at `axiom/gh-tooling/src/*.ts` — see
`axiom/docs/agents/issue-tracker.md` §Automation for the two operator
activation steps (enable Actions; optionally set `HYGIENE_SUMMARY_ISSUE`).

Until activated, role-label + audit-comment discipline is agent-enforced:
set the role at create and post the audit comment at close.

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

The vocabulary contract tests (prime-era `packages/coding-agent/test/gh-tooling/`)
are not on this baseline; the label vocabulary here is enforced by this file alone.
