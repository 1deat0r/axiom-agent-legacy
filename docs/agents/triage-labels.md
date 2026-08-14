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

1. When an issue opens with no role label, the workflow applies `needs-triage`
   and posts the readiness contract as a comment.
2. When an issue closes without an audit comment, the workflow posts a
   reminder. The audit comment must carry `Commit:`, `ADR:`, and `Handoff:` in
   one comment.

Agents must still set the role at create and post the audit comment at close.
The workflow is the safety net, not the primary path.

## Drift check

The live label set must match this file. To verify:

```
gh label list --limit 50
```

Fix drift with `gh label create` / `gh label delete`. The contract tests in
packages/coding-agent/test/gh-tooling/ guard the templates and the workflow
against the same vocabulary.
