# ADR-0050: Issue-tooling hardening — readiness contract, close ritual, and triage automation

Status: accepted
Date: 2026-08-14

## Context

The repo tracks work as GitHub issues (docs/agents/issue-tracker.md). The
docs named five triage roles, but the system had gaps. The docs did not say
what `ready-for-agent` means. No rule forced a role label at create time.
Several issues shipped with no label. No form guided the reporter. No ritual
linked an issue close to its merge, ADR, and handoff. The wayfinder labels
existed only in the docs. A fresh reviewer scored the system 7/10.

## Decision

The system now has five parts:

1. **Vocabulary.** The live repo holds exactly ten labels: five role labels
   and five wayfinder labels (docs/agents/triage-labels.md). No other labels.
2. **Readiness contract.** `ready-for-agent` requires five parts: goal,
   acceptance criteria, scope, ADR status, verification plan. The contract
   lives in triage-labels.md.
3. **Create rule.** Every issue gets exactly one role label in the create
   command. Two issue forms (.github/ISSUE_TEMPLATE/) encode the contract.
   Blank issues are off.
4. **Close ritual.** No issue closes without an audit comment that links the
   merge commit, the ADR, and the handoff (issue-tracker.md).
5. **Automation.** The workflow .github/workflows/triage.yml has two jobs.
   The open job applies `needs-triage` and posts the contract when an issue
   opens with no role label. The close job posts a reminder when an issue
   closes without an audit comment (`Commit:`, `ADR:`, `Handoff:` in one
   comment). The issue forms pre-apply `needs-triage`; the maintainer sets the
   final role after triage. The form has no role dropdown, because GitHub
   forms cannot set labels from a field.

The classifier logic lives in packages/coding-agent/src/core/gh-tooling/ as
pure functions with unit tests. Contract tests guard the workflow, the forms,
and the label vocabulary.

## Consequences

- A fresh agent can file, claim, and close issues with no guesswork. The docs
  give exact commands.
- The safety net catches unlabeled issues from humans.
- The audit comment links every closed issue to code, decision, and proof.
- The label vocabulary is opinionated. The default GitHub labels (bug,
  enhancement, and the rest) are deleted. A team that wants those labels must
  extend the vocabulary in triage-labels.md first.
- The triage workflow runs on every issue open and close. It needs the
  GITHUB_TOKEN with issues write. The open job never edits an issue that
  carries a role label. The close job never nudges an issue that carries an
  audit comment or a prior nudge.

## Follow-ups (2026-08-14, post-merge)

Two reviews drove three refinements:

- **Scope note.** The close ritual applies to closes from this ADR onward.
  The 13 legacy closes predate the policy. A drift-check command lists closed
  issues that lack the audit markers.
- **Exactly-one enforcement.** The open job now fires on `labeled` and
  `unlabeled` too. Two or more role labels get a conflict note. A stripped
  role gets a contract reminder but no re-apply, so a maintainer can switch
  roles without a loop.
- **Form wording.** The form pre-applies `needs-triage` via its `labels` key;
  the preamble now says so instead of naming the workflow as the applier.

The classifier logic stays pure and unit-tested; the workflow runs the same
code the tests exercise. The close job reminds once by design; the drift
check is the sweep.
