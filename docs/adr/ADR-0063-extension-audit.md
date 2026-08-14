# ADR-0063: Extension audit — keep the four pi-extension workspaces, no wire-in, no archive

**Status:** accepted
**Date:** 2026-08-14
**Extends:** ADR-0028 (security fence), ADR-0049 (git guard), ADR-0014 (confinement substrate)
**Evidence:** docs/extension-audit.md (full per-package audit)

## Context

Issue #41 asked for the fate of the four under-integrated `pi-extension-*`
packages. They are npm workspaces nested under
`packages/coding-agent/examples/extensions/` (`with-deps`, `sandbox`,
`custom-provider-anthropic`, `custom-provider-gitlab-duo`), all listed in
the root `workspaces` array. The `pi-extension-` names are upstream axiom
branding, not pi-fork leftovers: the dirs came from upstream commits and
exist on the `upstream-pi/main` lineage as well, so they are out of scope
for `docs/ports.md`.

The audit's evidence (docs/extension-audit.md) established:

- **The seam they ride is intact.** The loader honors the `pi.extensions`
  manifest (`readPiManifest` in `core/extensions/loader.ts`); `tsgo
  --noEmit` exits 0 with the root include covering
  `packages/coding-agent/examples/**/*`, so all four typecheck against the
  current API; every value import they make is exported today.
- **Exactly one importer exists in the whole repo**:
  `test/extensions-discovery.test.ts:302` loads `with-deps` as a live
  fixture. The other three have zero importers but nonzero docs value
  (README rows, extensions.md table rows, custom-provider.md example
  links, ADR-0014's confinement-substrate sentence).
- **Typecheck and runtime bind differently.** The loader aliases
  `@earendil-works/pi-*` to `packages/*/dist/index.js`, so examples run
  against the built dist while the typecheck checks source. A stale dist
  can drift from what the typecheck proved.

## Decision

Keep all four packages in place. No package is wired in, and no package is
archived.

- `with-deps`: keep — it is already wired in as the canonical fixture for
  the extension loader's dependency-resolution property.
- `sandbox`: keep — docs value plus ADR-0014's confinement-substrate
  reference; wiring it in is a security-policy decision (system deps,
  every bash call mediated, overlap with the ADR-0028 fence and ADR-0049
  git guard), not a plumbing one. Requires operator sign-off if pursued.
- `custom-provider-anthropic`: keep as a reference example — the built-in
  anthropic provider with OAuth already covers its function; its unique
  stealth mode is terms-of-service gray, so no wire-in.
- `custom-provider-gitlab-duo`: keep — the one additive provider example;
  wire-in behind a config flag is acceptable later if a GitLab Duo
  operator verifies it live (internal GitLab endpoints can change).

The archive criterion from the issue (zero importers AND zero docs value)
is met by none of the four, so no archive commit is prepared. If the
operator still wants fewer workspaces, docs/extension-audit.md lists each
archive's cost: workspace entry removal, `package-lock.json`
regeneration (build-config touch, full test floor required), and doc-link
fixes.

## Consequences

- The four workspaces stay in the build graph (hoisted deps, no-op
  scripts, covered by the root typecheck), which is the status quo — no
  behavior change to live code.
- The runtime-versus-typecheck binding split (examples run against dist,
  typecheck against source) is recorded as a standing hazard for anyone
  who loads these examples: rebuild dist before trusting a loaded example
  to match source.
- If a future session wires in `sandbox` or `gitlab-duo`, it needs its own
  ADR (security posture change / live-credential verification
  respectively), not a silent edit to this decision.
