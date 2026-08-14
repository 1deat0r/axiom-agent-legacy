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

An independent fresh-context reviewer scored the system. See
/tmp/gh-tooling-review-1.md on the host (not in the repo).

## What remains

- Live end-to-end proof of the triage workflow: file a deliberately unlabeled
  issue after merge and watch the action apply needs-triage and post the
  contract.
- Optional: the same treatment for PRs if the PR-triage flag flips to yes.
