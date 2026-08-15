# axiom-sovereign

Axiom's sovereign layer — the identity/memory/skills store ported from 3V0's
`3v0/core` to TypeScript. The Hermes runtime stays stock (Python); this package
owns the store logic only.

- `src/memory.ts` — provenance-aware, versioned memory store (JSON on disk;
  supersession never destroys — the audit trail is the point).
- `src/profile_io.ts` — the `§`-delimited wire format for MEMORY.md / USER.md.
- `src/lock.ts` — cross-process lockfile (O_EXCL + stale reclaim).

## Commands

```sh
npm install
node --test test/memory.test.ts   # run tests (Node 26 runs .ts natively)
npx tsc --noEmit                  # typecheck
```

## Conventions

- Erasable TypeScript only (no enums/namespaces/parameter-properties) —
  enforced by `erasableSyntaxOnly`.
- `.ts` specifiers in relative imports (Node 26 type-stripping does not rewrite
  `.js` → `.ts`).
- Store data files are byte-compatible with the Python implementation.
