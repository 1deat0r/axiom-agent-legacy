# Handoff: extension audit (issue #41)

Branch `feat/extension-audit` (isolated worktree
`/tmp/axiom-worktrees/extension-audit`, cut from origin/main = 473516062).
ADR-0063. Documentation only — no live-code changes.

## What was done

Audited the four `pi-extension-*` packages — npm workspaces nested under
`packages/coding-agent/examples/extensions/` (`with-deps`, `sandbox`,
`custom-provider-anthropic`, `custom-provider-gitlab-duo`), all in the
root `workspaces` array. One correction to the issue text: they are under
`packages/`, one level below the top-level glob. The `pi-extension-`
names are upstream axiom branding, not pi-fork leftovers (upstream commits
c6fc08453, 4751ebddb, 758baa9fe; also present on `upstream-pi/main`), so
they are out of scope for `docs/ports.md`.

Deliverables:

1. `docs/extension-audit.md` — per-package purpose, importers, wire-in
   cost, archive cost, and a recommendation, with the shared evidence
   (loader seam intact, typecheck-versus-runtime binding split, hoisted
   deps, docs value).
2. `docs/adr/ADR-0063-extension-audit.md` — decision: keep all four, no
   wire-in, no archive.
3. This handoff.

## Decision summary

- `with-deps`: keep — already wired in as the live fixture in
  `test/extensions-discovery.test.ts` ("resolves dependencies from
  extension's own node_modules").
- `sandbox`: keep — docs value plus ADR-0014's confinement-substrate
  reference; wire-in is a security-policy decision (overlaps ADR-0028
  fence and ADR-0049 git guard), operator-gated.
- `custom-provider-anthropic`: keep as reference example — built-in
  anthropic provider with OAuth already covers its function.
- `custom-provider-gitlab-duo`: keep — additive provider example; optional
  flag-gated wire-in if a GitLab Duo operator verifies it live.

No package met the issue's archive criterion (zero importers AND zero docs
value), so no archive commit was prepared.

## What was verified

- Import graph: grep for the four package names and dir paths over the
  repo — single non-doc hit, the with-deps test fixture.
- `tsgo --noEmit` exit 0 on the branch (root include covers
  `packages/coding-agent/examples/**/*`).
- `test/extensions-discovery.test.ts` 27/27 (vitest), including the
  with-deps live-load fixture.
- Full `./test.sh` floor: see the report file
  `/tmp/axiom-worktrees/extension-audit-report.md` for counts; only the
  documented sandbox known-fails (4603 x4, 4685 x9 EXDEV,
  daemon-serialized-refine x1) are expected, plus standalone-passing
  flakes under load.
- No live-code changes: `git show --stat` on the branch is docs only.

## What was not done (and why)

- No wire-in of any package (out of scope; ADR-0063 defers to future
  operator decisions).
- No archive commit (no package met the criterion; a dead package would
  need workspace removal plus lock regeneration plus doc-link fixes).
- No live loading of the sandbox or provider examples (needs system deps
  and API credentials respectively; operator-gated).
