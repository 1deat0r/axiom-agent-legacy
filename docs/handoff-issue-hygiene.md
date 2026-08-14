# Handoff: issue-hygiene operator (issue #42)

Branch: feat/issue-hygiene. ADR: docs/adr/ADR-0064-issue-hygiene-operator.md.

## What was done

**Immediate fixes (live, not code).**

- Issue #25 body rewritten to the full readiness contract (goal,
  acceptance criteria, scope, ADR status, verification plan). Label moved
  from needs-triage to ready-for-agent.
- Wave-5 commits on origin/feat/gh-tooling-hardening reviewed against
  ADR-0050 and issue #27. Verdict: clean, zero findings. Every wave-5
  file (triage.ts, both CLIs, triage.yml, both issue templates, the three
  doc files, the handoff, all four test files) is blob-identical on
  origin/main. The content landed on main via commits 984f58d26 and
  7b2fcda31. The branch itself is stale (its six wave-5 commits are not
  ancestors of main, and it lags main by 5313 lines of parallel work).
  Nothing was merged. Parent action: post a short reconciliation note on
  issue #27 and delete the stale branch.

**Automation.**

- .github/workflows/issue-hygiene.yml: weekly sweep (Monday cron) plus
  workflow_dispatch. Gathers open issues (--limit 1000, the gh ceiling,
  no --paginate) and every remote branch with ahead/behind counts, pipes
  both into the tested classifier, and posts one summary comment on the
  HYGIENE_SUMMARY_ISSUE repository variable issue (set to 42) only when
  the problem set changed since the previous sweep comment. Never edits
  labels, never closes issues, never merges, never deletes branches.
- packages/coding-agent/src/core/gh-tooling/hygiene.ts: pure classifier.
  Five problem shapes: missing role label, role conflict, unknown label,
  stale needs-triage (older than seven days), unmerged branch (open issue
  references a branch with commits not on main). Fingerprint = djb2 hash
  of the sorted problem list; dedupe reads the last sweep comment's
  fingerprint trailer.
- packages/coding-agent/src/core/gh-tooling/hygiene-cli.ts: stdin JSON to
  one decision line, same shape as the triage CLIs.
- docs/agents/stale-branches.md: who cleans stale branches and worktrees,
  and how. Content diff, not the commit graph, is the proof of staleness.
- CONTEXT.md, docs/agents/triage-labels.md, docs/agents/issue-tracker.md:
  sweep and stale-branch vocabulary wired into the existing docs.

## What was verified

- Unit: test/gh-tooling/ = 86/86 green. hygiene.test.ts 23 tests red-first
  (wrote them, watched the module-missing failure, then implemented).
  hygiene-workflow.test.ts 10 tests guard the YAML (parses, weekly cron,
  permissions, --limit 1000 not --paginate, fetch-depth 0, post-only-on-
  change, summary-issue variable, no label edits or closes).
- Workflow YAML schema-validated against the official GitHub Actions JSON
  Schema (SchemaStore github-workflow.json, draft-07 via ajv-cli):
  "/tmp/issue-hygiene.json valid".
- Live read-only dry-run of the sweep logic against real gh data: exactly
  two findings, both real - feat/gh-tooling-hardening ahead 6 referenced
  by #42, feat/root-guard ahead 15 referenced by #17. No label drift
  found (issue #25 fixed in this run). Action post, fingerprint d2f20374.
- Full ./test.sh floor: 5284 passed, 16 failed. Of the 16: 4603 x4,
  4685 x9, daemon-serialized-refine x1 (the documented sandbox
  known-fails) plus 2 flakes - 4428 real-kernel test passes standalone
  (5/5), and daemon-supervisor-process fails differently on every run
  (machine-load flake, no causal link to this branch which touches only
  gh-tooling, workflow, and docs). biome clean (the 2 remaining infos are
  the pre-existing telegram-transport useTemplate unsafe fixes). tsgo
  --noEmit clean.

## What was mocked vs not done

- The scheduled cron path was not run on GitHub Actions; only
  workflow_dispatch would exercise it live. The dry-run used the exact
  data-gathering commands the workflow uses.
- The HYGIENE_SUMMARY_ISSUE variable is set to 42; when that issue
  closes, the operator must repoint it.
- Orphan branches (ahead of main, no open issue references them) are not
  reported by design; ADR-0064 lists it as a follow-up.
