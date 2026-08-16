# Handoff — tracker automation CI port (session 8)

Written 2026-08-16 (session 8). The prime-era tracker automation (triage +
issue-hygiene workflows) is ported to the Hermes baseline, re-pointed at
`axiom/gh-tooling/`. Issue #66, closed. Activation remains operator-gated.

## What was done

1. Ported the decision logic to `axiom/gh-tooling/src/` — `triage.ts`,
   `hygiene.ts`, and the three stdin→JSON CLIs (`triage-cli.ts`,
   `triage-close-cli.ts`, `hygiene-cli.ts`), copied from the prime-era
   `packages/coding-agent/src/core/gh-tooling/` (archive branch) with three
   surgical adaptations: `.ts` import specifiers (this baseline's
   convention), docs pointers re-anchored to `axiom/docs/agents/*`, and the
   readiness-contract verification mention re-anchored to
   `scripts/run_tests.sh` (Python) + `node --test` + `npm run typecheck`
   (TS). Zero runtime deps beyond `tsx` (fetched at workflow runtime).
2. Ported the test suites first, red-first (`node --test`): 62 tests across
   `test/triage.test.ts` + `test/hygiene.test.ts`, sourced from the
   prime-era vitest suites with added re-anchoring assertions (the bare
   prime-era docs path must never appear without the `axiom/` prefix).
3. Re-pointed the two workflows: `.github/workflows/triage.yml` +
   `.github/workflows/issue-hygiene.yml` — prime-era files verbatim except
   `actions/checkout` SHA-pinned (`de0fac2e4500dabe0009e67214ff5f5447ce83dd`,
   v6.0.2) per the repo dependency-pinning policy and the CLI paths moved
   to `axiom/gh-tooling/src/*.ts`.
4. Re-anchored the docs: `axiom/docs/agents/issue-tracker.md` +
   `axiom/docs/agents/triage-labels.md` Automation sections now state the
   CI is ported and name the two operator activation steps; ADR-0050 and
   ADR-0064 gained "Adapted for the Hermes baseline" sections (ADR-0011
   spend-cap precedent).

## Verified (how)

- `node --test` — 62/62 green (triage decision table, close nudge, sweep
  problem types, fingerprint dedup, re-anchored text assertions).
- `npm run typecheck` — clean (exit 0; the `tsc` token is avoided per the
  Hermes terminal-guard quirk).
- CLI smoke tests — all eight payloads behaved per the prime-era contract:
  zero-label open → `needs-triage` + contract; role conflict → note;
  bot-sentinel suppression; close with audit → skip; close without → nudge;
  sweep missing-role → post; clean → none; repeat sweep → fingerprint skip.
- Live `gh` pipeline — the workflow's exact Decide/Check invocations run
  against the real `gh issue view --json` output for issue #66 (skip on
  open, nudge on close-check) after stripping the harness's forced ANSI
  color (GitHub Actions emits plain JSON; the harness exports
  `CLICOLOR_FORCE=1`).
- YAML — both workflow files parse clean.

## Operator activation steps (NOT done — inert until then)

1. Enable GitHub Actions on the fork: Settings → Actions → General →
   Allow all actions.
2. Optional: set the `HYGIENE_SUMMARY_ISSUE` repo variable (Settings →
   Secrets and variables → Actions → Variables) to the issue number that
   should receive the weekly sweep summary.

Until activated, the role-label + audit-comment discipline stays
agent-enforced (set the role at create; post the audit comment at close).

## Not ported (out of scope, per issue #66)

- Prime-era `contribution-gate.yml`, `live-verification.yml`, and the
  `templates.test.ts` / live-verification tests — no counterpart surface
  on this baseline.
- `review_session.py` / `on_session_end` wiring (out of scope since
  port #3).
