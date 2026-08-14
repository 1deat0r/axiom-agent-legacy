# ADR-0070 — Core write tool: exclusive-create and atomic-overwrite semantics

## Status

Accepted (2026-08-15)

## Context

The 2026-08-15 meta for coding-agent cores is a minimal set of deterministic
file tools: read, write, edit, bash. This fork removed the legacy pi-mono
write builtin (regression #4428) and writes files today through bash heredocs
or python one-liners in the ipython kernel. Those paths carry quoting hazards
(a corrupted `>>>>>>>` heredoc was observed in production), have no
fail-on-exists guarantee, and can clobber through symlinks.

## Decision

A dedicated `write` tool joins the core toolset (stacked on `feat/read-tool`,
ADR-0067). The contract:

1. **Two modes.** `mode: "create"` (default) opens with O_EXCL, so an existing
   file (or symlink, dangling or not) fails with a clear error and a hint to
   use overwrite. `mode: "overwrite"` writes a temp file in the target
   directory and renames it over the target: atomic on the same filesystem,
   and a symlink at the target is replaced, never followed.
2. **No partial writes.** The temp-plus-rename path means a crash mid-write
   leaves the old file intact and the temp file is removed on failure.
3. **Permission, ending, and BOM preservation.** Overwrite copies the existing
   file's mode onto the temp file, preserves CRLF or LF endings, and mirrors
   the existing BOM (old file had one -> the new file gets one; old file had
   none -> the user's content is written as given). `lineEndings` overrides.
   Create mode writes LF and never adds a BOM.
4. **Diff on overwrite.** Overwrite returns a unified diff (the shared
   `generateDiffString` renderer) so the model and the user see exactly what
   changed.
5. **Serialized mutations.** Writes to the same path go through
   `withFileMutationQueue`, the same serialization edit uses, so read-diff-
   write cycles cannot interleave.
6. **Parent directories must exist.** No implicit directory creation.

The five write cases of the threat corpus (W1 symlink replace, W2 O_EXCL
create race, W3 dangling-symlink block, W4 temp-file hygiene, W5 directory
target) live in `test/read-write-threat-corpus.test.ts` alongside the read
cases.

## Consequences

- Sessions without an explicit tool allowlist now expose `read` and `write`
  alongside `ipython`. The fork's regression #4428 assertions were updated to
  the new builtin set (ipython, read, write); grep/find/ls stay removed.
- The core now matches the 2026-08-15 meta's read/write half with stricter
  semantics than the meta (O_EXCL create, atomic overwrite, symlink replace).
  bash and edit remain available as factories for custom sessions; activating
  them by default is a separate decision (candidate issue).
- `--tools write` is accepted by the CLI; the availability message lists
  ipython, read, write.
