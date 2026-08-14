# Handoff: operator-gated live verification harness (issue #36)

Branch `feat/live-verification` (isolated worktree
`/tmp/axiom-worktrees/live-verification`, cut from origin/main =
33858818f). ADR: ADR-0058.

## What was done

1. `tools/live-verification/catalog.mjs` (new): the four-check catalog
   (provider-chat, agent-run, rlm-kernel, gateway-delivery), each with a
   name, what it proves, its env requirements, and its expected output; plus
   the pure `missingRequirements` / `plan` / `summarize` skip-not-fail logic.
   `makeDefaultDeps` wires real filesystem probes; the unit tests inject
   fakes so no test touches the network, the dist tree, or a real kernel.
2. `tools/live-verification/run.mjs` (new): CLI (`--list`, `--check <id>`,
   `--json`). All-SKIP is exit 0; exit 1 only when a check that ran failed;
   exit 2 on usage errors. Never logs a key value.
3. `.github/workflows/live-verification.yml` (new): `workflow_dispatch` plus
   a `/run-live` PR comment trigger (PRs only); repository secrets map
   one-to-one onto the exact env names the script reads; the PR report
   comment posts only when at least one check ran, so keyless runs stay
   silent and green.
4. `docs/live-verification.md` (new): operator handbook — the check table,
   the exit contract, the CI trigger, and the follow-up ledger: one checkbox
   per ADR item that defers a live pass to the operator (ADR-0016, 0017,
   0020, 0021, 0023, 0029, 0052 — literal and equivalent phrasings both
   listed, each linked to its ADR).
5. `tools/live-verification/RUN.md` (new): operator run recipe.
6. `CONTEXT.md`: added the "Live verification" term.

## What was verified and how

- **Unit (offline, red-first):** `packages/coding-agent/test/live-verification.test.ts`
  (18 tests) — the two files were written against a nonexistent catalog and
  workflow and failed on import (red evidence captured in the report), then
  went green. Coverage: catalog shape (four checks, metadata, env gates),
  `missingRequirements` anyOf semantics, `plan` partitioning for keyless /
  partial / fully provisioned environments, `summarize` exit decision
  (all-SKIP = 0, one FAIL = 1), and `run.mjs` offline end-to-end (no keys:
  exit 0, all SKIP; `--check` selection; `--list`; unknown id = exit 2).
- **Unit (workflow schema):** `packages/coding-agent/test/gh-tooling/live-verification-workflow.test.ts`
  (10 tests) — YAML parses, triggers, permissions, secret 1:1 mapping, build
  before run, `--json` invocation, silent-skip comment gate, report counts.
- **Lint/type floor:** `biome check` clean on the new test files; `tsgo
  --noEmit` clean on the worktree.
- **Mock, not live:** the four runners themselves (fetch probes, the CLI
  spawn, the kernel boot) were NOT executed against real providers — the
  sandbox has no keys and no live network is permitted in unit tests. Their
  offline skip/plan contract is fully tested; their live behavior is the
  operator pass this harness exists to enable.
- **Not done (scope):** no CI secrets management, no gateway boot, no full
  message round-trip. Recorded as operator checkboxes in
  `docs/live-verification.md`.

## Notes for the parent

- The parent runs the full `./test.sh` floor at merge time; this branch adds
  no changes outside `tools/`, `.github/workflows/`, `docs/`, `CONTEXT.md`,
  and two new test files, so existing suites should be untouched. The two
  new suites pass from the worktree root with the standard single-suite
  command.
- `tools/*` and `.github/*` are outside biome's file include list; the
  catalog and runner are dependency-free ESM with a hand-written
  `catalog.d.mts` so tsgo stays clean for the test importer. Keep that pair
  in sync if the catalog's public surface changes.
