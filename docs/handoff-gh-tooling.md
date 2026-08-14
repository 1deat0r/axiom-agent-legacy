# Handoff: GitHub issue-tooling hardening

Date: 2026-08-14
Branch: feat/gh-tooling-hardening
Issue: #27
ADR: ADR-0050

## What was done

The repo's GitHub issue-tooling system now has five parts:

1. A ten-label vocabulary. Five role labels (needs-triage, needs-info,
   ready-for-agent, ready-for-human, wontfix) and five wayfinder labels.
   The live repo holds exactly this set. The default GitHub labels are
   deleted.
2. A readiness contract. ready-for-agent requires five parts: goal,
   acceptance criteria, scope, ADR status, verification plan.
3. A create rule. Every issue gets exactly one role label at create. Two
   issue forms encode the contract. Blank issues are off.
4. A close ritual. No issue closes without an audit comment that links the
   merge commit, the ADR, and the handoff.
5. Automation. The workflow .github/workflows/triage.yml applies
   needs-triage and posts the contract when an issue opens with no role
   label.

The classifier lives in packages/coding-agent/src/core/gh-tooling/ as pure
functions. Contract tests guard the workflow, the forms, and the vocabulary.

## What was verified

- 25 unit and contract tests, red first, green after (test/gh-tooling/).
- The workflow pipeline smoked locally with the real gh JSON shape.
- Biome clean (1090 files). tsgo clean.
- Full ./test.sh: only the documented sandbox known-fails (4603 x4, 4685 x9,
  daemon-serialized-refine x1, kernel-attach-image x1). The kernel-attach-image
  flake and the gh-tooling suite pass standalone.
- Live label set matches the vocabulary: exactly ten labels.
- Every open issue carries a role label. Issue #26 body upgraded to the
  contract. Issue #27 demonstrates the system on itself.

## Review

Reviewer 1 (fresh context, strict rubric): 8/10. Findings: the workflow had
never run on the default branch, the close ritual had no enforcement, two
closed issues carried no label, and the form role dropdown could not set
labels. All four are fixed. Reviewer 2 runs after the fixes.

## Live verification (post-merge)

The workflow runs on main. Proof, end to end:

- Issue #28 (deliberately unlabeled) opened. Within 15s the open job applied
  needs-triage and posted the readiness contract. Closed with an audit
  comment; the close job stayed silent.
- Issue #29 (deliberately unlabeled) opened and closed without an audit
  comment. Within 30s the close job posted the reminder. After the audit
  comment landed, no second reminder.
- The live label set matches the vocabulary: exactly ten labels. Every open
  and closed issue carries a role label. The six most recent closes carry
  backfilled audit comments.

## Wave 4 (reviewer 3)

Reviewer 3 scored 8.5. The findings were narrow. All are fixed:

- Issue #13 closed post-ADR without an audit comment. The close job nudged
  it. The audit comment now lands with the not-applicable form. The close
  ritual template now defines that form (Commit: not required, with a
  reason). The drift check returns exactly the 13 legacy closes.
- The bug form wording now says the form pre-applies needs-triage. The
  wording test guards both forms.
- The drift and list commands carry --limit 100. The drift note explains the
  two groups (legacy exempt, post-ADR violations).
- The ADR records the three chosen boundaries: marker check not substance
  check, label check not body check, one reminder per close.

45 tests green. Live proof stands on issues #13, #27, #28, #29.

## What remains

- Optional: the same treatment for PRs if the PR-triage flag flips to yes.
- Optional: a scheduled drift-sweep workflow, if unanswered nudges become a
  pattern.
