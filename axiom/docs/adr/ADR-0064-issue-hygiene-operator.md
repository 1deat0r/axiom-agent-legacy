# ADR-0064: Issue hygiene operator — weekly sweep, stale-branch policy, and drift reconciliation

Status: accepted
Date: 2026-08-14

## Context

ADR-0050 built the issue tooling: a ten-label vocabulary, the readiness
contract, the create rule, the close ritual, and an event-driven triage
workflow. That workflow guards the moment an issue opens or closes. It does
not sweep: it never re-checks issues that drifted while open, never looks at
branches, and never reconciles work that was reviewed but not merged.

The repo showed all three drift shapes at once. Issue #25 carried a
two-line body and a `needs-triage` label while its work sat merged-quality on
a branch. The wave-5 commits on `feat/gh-tooling-hardening` were not
ancestors of main, so the issue #27 close looked complete when the branch
still held unreconciled commits. Two worktrees sat abandoned after their
branches merged.

ADR-0050 named the sweep a future option. This ADR builds it.

## Decision

The system gains three parts:

1. **Weekly sweep workflow** (`.github/workflows/issue-hygiene.yml`). A
   scheduled job (weekly, Monday) plus `workflow_dispatch`. It gathers all
   open issues (`gh issue list --state open --limit 1000`, the gh ceiling —
   no `--paginate` in this gh version) and every remote branch with its
   ahead/behind counts against main (`git rev-list --count`). It pipes both
   into the tested classifier and posts **one summary comment** per run on
   the issue named by the `HYGIENE_SUMMARY_ISSUE` repository variable
   (set to 42 at ship time). The comment carries a problem fingerprint; a
   run whose problem set matches the previous sweep's fingerprint posts
   nothing. With no problems at all, nothing is posted. When the variable is
   unset, the summary goes to the workflow step summary only. The sweep
   never edits labels, never closes issues, never merges, never deletes
   branches.
2. **Pure classifier** (`packages/coding-agent/src/core/gh-tooling/hygiene.ts`).
   Four problem shapes: missing role label, role conflict (two or more role
   labels), unknown label (outside the ten-label vocabulary), stale
   `needs-triage` (older than seven days), and unmerged branch (an open
   issue references a branch with commits not on main). The fingerprint is a
   djb2 hash of the sorted problem list; the last sweep comment is found by
   the `Issue hygiene sweep` sentinel and its `<!-- hygiene-fingerprint:
   <hex8> -->` trailer. `decideSweep` parses the gh-shaped JSON; the CLI
   (`hygiene-cli.ts`) reads stdin and writes one decision line, exactly like
   the triage CLIs.
3. **Stale-branch policy** (`docs/agents/stale-branches.md`). Defines active,
   stale, and abandoned. The closing agent deletes its branch and worktree in
   the same run that posts the audit comment. Content, not the commit graph,
   is the proof of staleness: `git diff origin/main origin/<name> --stat`
   empty means reconciled. The sweep never deletes.

The sweep is read-only except for its one comment. A human or an agent acts
on every finding.

## Consequences

- Drift surfaces within a week instead of at review time. The sweep comment
  is the single inbox for label drift, stale triage, and unmerged work.
- The workflow needs `contents: read` and `issues: write`, the GITHUB_TOKEN,
  and a `HYGIENE_SUMMARY_ISSUE` variable. The summary issue is a moving
  target: when it closes, point the variable at the next hygiene operator
  issue.
- Ahead-count is commit-graph based. A branch whose content was
  cherry-picked to main (wave-5 is the live example) still reads as ahead.
  The stale-branch policy resolves this with the content diff, not the graph.
- Orphan branches (ahead of main, no open issue references them) are
  invisible by design. A future sweep can list them; the policy documents the
  manual check.

## Follow-ups

- Report orphan branches (ahead of main, unreferenced) as a softer finding.
- Track per-problem age so a finding can escalate after two silent weeks.

## Adapted for the Hermes baseline (ADR-0087, 2026-08-16)

The ADR-0087 re-foundation moved Axiom onto the Hermes Agent baseline
(port, issue #66). The prime-era `.github/workflows/issue-hygiene.yml`
invoked `npx tsx packages/coding-agent/...`; the port re-points it at
`axiom/gh-tooling/src/hygiene-cli.ts` and adapts the decision logic. The
semantics are unchanged: the weekly (Mon 03:23) + `workflow_dispatch` sweep
reports missing-role, role-conflict, unknown-label, stale-`needs-triage`,
and unmerged-branch findings, deduplicated by the sweep fingerprint and
posted to the `HYGIENE_SUMMARY_ISSUE` repo var when set.

- **Decision logic re-anchored.** `axiom/gh-tooling/src/hygiene.ts` is the
  prime-era `packages/coding-agent/src/core/gh-tooling/hygiene.ts` with the
  missing-role detail text pointing at
  `axiom/docs/agents/triage-labels.md`. Problem types, the
  djb2-style fingerprint, the stale threshold (7 days), and the
  ahead-count-only branch check are unchanged.
- **Workflow adapted.** `actions/checkout` is SHA-pinned per the repo
  dependency-pinning policy; the `git fetch` branch-heads collection, the
  `gh` JSON assembly via `jq`, and the summary/step-summary posts are
  preserved from the prime-era file.
- **Inert until activated.** The scheduled run only fires once GitHub
  Actions is enabled on the fork (operator step). The ported unit tests
  (`axiom/gh-tooling/test/hygiene.test.ts`, node --test) lock the sweep
  decision table and the re-anchored text; written first, sourced from the
  prime-era vitest suite.
