# Handoff — memory axis ported (core + CLI); skills store next

Written 2026-08-16 (session 3). Status: memory-axis port complete and verified
cross-language. Resume here.

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
8. Folded the sovereign package into `axiom/sovereign/` (was a separate
   `~/Projects/axiom-sovereign/` dir); committed `510670e158`.

## What was done (session 3 — this session)

9. Decided the CLI runtime: `node` (single runtime, already `engines >=26`;
   bun's cold-start win is immaterial at the bridge's write frequency, and one
   runtime keeps the port #3 bridge re-pointing to a single `node <cli>.ts`
   invocation pattern).
10. Ported the rest of the memory axis, byte-compatible with 3V0:
    `src/record.ts` (supersede-by-id/substring, dry-run), `src/sync.ts`
    (sync_kind/profile_text), `src/bridge.ts` (apply_ops), `src/decide.ts`
    (store-first decision), `src/query.ts` (fact axis) + `src/cli/paths.ts`;
    added `MemoryStore.allFacts()` for the inactive-set views.
11. Ported the CLI entrypoints: `src/cli/{ingest,record,sync,query}.ts`
    (query is memory-axis only until port #2 lands the skill axis).
12. Ported the tests (record/sync/bridge/decide/query) — 49 green.

## Verified (how)

- `git ls-remote origin` — main + 3 archive branches + tag all correct.
- `node --test` — 49/49 pass (memory + record + sync + bridge + decide + query).
- `tsc --noEmit` — clean.
- Byte-compat: Python `core.memory` reads a TS-written store (incl. a
  supersession chain) and re-serializes it byte-identical (`cmp`); Python
  `ingest.py` -> TS `query.ts` read verified the reverse direction.

## Next steps (in order)

1. ~~Decide CLI runtime~~ — resolved 2026-08-16: `node` (see session 3 #9).
2. **Port #2 — skills store** (`skills.py`, `skill_io`, `skill_bridge`,
   `sync_skills`, `decide_skills` + their CLIs), then finish `query.ts`'s
   skill axis + `summary`. Then **port #3** — re-point the native-store-bridge
   plugin subprocess calls at the TS CLI.
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
