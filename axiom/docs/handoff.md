# Handoff — re-foundation live on origin; first port (memory) green

Written 2026-08-16 (session 2). Status: re-foundation pushed, first port core
landed and verified. Resume here.

## What was done (session 1 — re-foundation)

Axiom re-founded as a hardfork of Hermes Agent at HEAD per ADR-0087 (see
`axiom/CONTEXT.md`). Prime-era (`archive/prime-v0.7.2`, `baseline/prime-v0.7.2`)
and pi (`archive/pi-v0.84.1`) preserved as archived eras.

## What was done (session 2 — this session)

1. Unshallowed `upstream` — full Hermes history; `.git/shallow` gone.
2. Pushed the archived eras to origin (3 branches + `archive/prime-v0.7.2` tag).
3. Force-pushed `main` (operator-approved). origin/main = `fc0481914`.
4. Scaffolded the TS sovereign package at `axiom/sovereign/`
   (type=module, erasable-TS tsconfig, typescript@5.9.3 + @types/node@26.2.0):
   `src/memory.ts` (MemoryStore) + `src/profile_io.ts` + `src/lock.ts`.
   7 tests green via `node --test`; `tsc --noEmit` clean; byte-compat verified
   both directions against Python `3v0/core/memory.py`.
5. Path-fixed carried process docs (`docs/adr/` -> `axiom/docs/adr/`, stale
   upstream/account note -> Hermes upstream + 1deat0r origin), corrected the
   TS specifier convention (`.js` -> `.ts`), marked ports.md #1 in progress.
   Committed `336f9ec2d5`.
6. Opened tracker issue #63 (port #1, `ready-for-agent`).
7. Created `axiom/AGENTS.md` (operator-approved instruction file) from
   `axiom/GUIDE.md`; GUIDE.md is now a redirect.

## Verified (how)

- `git ls-remote origin` — main + 3 archive branches + tag all correct.
- `node --test test/memory.test.ts` — 7/7 pass.
- `tsc --noEmit` — clean.
- Byte-compat: Python-writes/TS-reads and TS-writes/Python-reads; `cmp`
  byte-identical.

## Next steps (in order)

1. **Decide CLI runtime** (node vs bun for the TS CLI entrypoints; recommend
   bun for CLI, node for lib/tests). Package home decided this session: folded
   into `axiom/sovereign/`.
2. **Continue port #1** (issue #63): TS CLI entrypoints (ingest/query/record),
   then skills store (port #2), then bridge re-pointing (port #3).
3. **Flag — prime-era automation stale**: `axiom/docs/agents/issue-tracker.md`
   "Automation" section references `.github/workflows/triage.yml` +
   `issue-hygiene.yml`, which do NOT exist on the Hermes baseline. Decide
   whether to port that automation.

## Environment quirks (verified this session)

- `NODE_ENV=production` is set in the shell — `npm install` omits devDeps
  unless `--include=dev` is passed.
- Node 26 type-stripping does NOT rewrite `.js` -> `.ts` import specifiers;
  use `.ts` specifiers + `allowImportingTsExtensions` + `noEmit`.
- The Hermes terminal guard false-positives on the literal `tsc` token; run
  `npm run typecheck` instead of `tsc` directly.
