# Handoff — 2026-08-14 (shoehorn migration completed)

## Done

1. **Shoehorn migration finished (ADR-0048).** All four test packages
   (agent, ai, coding-agent, tui) now use `@total-typescript/shoehorn`
   for partial/wrong test data. Zero `as Type` and zero
   `as unknown as Type` assertions remain in test files.
2. **Repaired the broken single-arg `fromAny` sites.** The installed
   shoehorn types `fromAny` as `<T, U>` with no default, so ~980
   `fromAny<T>(v)` sites were TS2558 errors. All are now
   `fromAny<T, unknown>(v)`.
3. **Moved wrong-shape fixtures from `fromPartial` to `fromAny`.**
   ~430 sites that passed intentionally wrong or `unknown` data through
   `fromPartial` (TS2345) now use `fromAny<T, unknown>`.
4. **Fixed the vi.hoisted TDZ crashes.** Shoehorn calls inside
   `vi.hoisted` callbacks and `vi.mock` factories run before imports
   initialize and threw `ReferenceError: Cannot access '__vi_import_0__'`
   at module load (16 suites). Hoisted callbacks now carry an explicit
   return-type annotation (`vi.hoisted((): Shape => ({ ... }))`), and
   factories use `importOriginal<typeof import(...)>()`. The one
   `as never` kept is the standard vitest spawn-override idiom in
   `daemon-command.test.ts`, which has no type-level-only alternative.
5. **Cleanup.** Removed 62+ now-unused shoehorn imports; biome and
   typecheck are clean.

## How it was verified

- `npx tsgo --noEmit`: 0 errors (down from 1,412 after the earlier
  partial migration).
- `npx biome check .`: 0 diagnostics.
- `./test.sh`: all four packages green except pre-existing sandbox
  failures, confirmed identical at HEAD in a throwaway worktree:
  - `4603-worker-recovery` (4): EXDEV hard-linking the node binary in
    this btrfs subvolume layout (known-fail, see AGENTS.md).
  - `4685-daemon-client-modes` (9): `FORCE_COLOR=1` in this sandbox
    makes spawned node processes print the NO_COLOR warning on stderr,
    breaking `stderr === ""` assertions.
  - `daemon-serialized-refine-process` (1): daemon socket never
    appears in this sandbox; fails at HEAD too.
  - `kernel-attach-image-skill` (1): 30s timeout only under full-suite
    load; passes alone in 1.6s. Flake, file untouched by migration.
- Method: mechanical codemods (balanced-bracket lexer) for the bulk
  repairs, per-file hand edits for hoisted blocks; every step gated by
  typecheck + full suite. No test semantics changed (shoehorn returns
  its input unchanged).

## Notes

- `packages/ai/src/models.generated.ts` was regenerated from live
  provider catalogs (committed separately); the generator script is the
  source of truth and was not hand-edited.
- Remaining `as any` (197) and mock-factory `as never` (~4) are out of
  the migration's scope; see ADR-0048 consequences.
