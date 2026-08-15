# Handoff — sovereign-agent-on-Hermes pivot (TypeScript sovereign layer)

Written 2026-08-16 (end of session). Resume here tomorrow morning.
Status: direction decided, architecture understood, ZERO code written yet.

---

## 1. The decision (already made — do not re-litigate)

axiom-agent re-founds as a **sovereign agent modeled on 3V0**:

- **Foundation**: fork of Hermes Agent (`NousResearch/hermes-agent`) at HEAD, tracked upstream.
- **Improvement vector**: port 3V0's *sovereign layer* to TypeScript — **NOT** the Hermes runtime.
- **Runtime**: stays stock Hermes (Python). We do not rewrite Hermes core.

Operator explicitly chose (clarify answer, verbatim): *"On top of stock Hermes —
port 3V0's sovereign layer (identity/memory/skills store) to TypeScript, keep
Hermes as the runtime and track upstream."*

This **supersedes the prime-agent baseline (ADR-0015)**. The existing
`/home/mustbearn/Projects/axiom-agent` repo (prime-agent fork, ~85 ADRs) becomes
the superseded baseline — archive it like `archive/pi-v0.84.1`, do not build on
it. That archive is the operator-decision step (todo #9, below); do not do it
unprompted.

## 2. Ground truth verified this session (trust, do not re-derive)

- **Hermes is a hybrid**, not pure Python: ~4,243 `.py` files (~500K LOC core)
  AND ~2,206 `.ts`/`.tsx` files (`ui-tui`, `web`, `apps`). The TS rewrite is
  really "port the Python core" — the UI is already TS.
- **3V0's sovereign layer** = the `3v0/` dir in the body repo
  `/home/mustbearn/Projects/AI Agents/3V0 Agent`:
  - `core/` (13 files): `memory.py`, `profile_io.py`, `sync.py`, `record.py`,
    `bridge.py`, `skills.py`, `skill_bridge.py`, `skill_io.py`,
    `sync_skills.py`, `query.py`, `decide.py`, `decide_skills.py`, `__init__.py`
  - `scripts/` (11 CLI entrypoints): `ingest.py`, `ingest_skills.py`,
    `query.py`, `record.py`, `record_skills.py`, `sync.py`, `sync_skills.py`,
    `seed_from_profile.py`, `export_to_profile.py`, `seed_skills.py`,
    `review_session.py`
  - `plugin/native-store-bridge/` (profile plugin, the canonical source is in
    the body repo; a *copy* lives in `~/.hermes/profiles/3v0/plugins/`):
    `post_tool_call` hook mirrors `memory`→`data/memory.json` and
    `skill_manage`→`data/skills.json`; `on_session_end` spawns the detached
    `review_session.py`; registers `threev0_store` (read) + `threev0_record`
    (write) tools.
  - `data/memory.json`, `data/skills.json` — the canonical stores (source of
    truth; the profile is a *derived view*).
  - `tests/` (10 files).
- **Toolchain on this host**: Node v26.7.0 (native erasable-TS type stripping —
  no `tsx` needed), npm 12.0.2, bun 1.3.14, `tsc` NOT installed (pin
  `typescript` as a devDep for `tsc --noEmit`).

## 3. The key architectural insight (this IS the port strategy)

The JSON stores are **language-agnostic**, and the bridge is **already a
subprocess boundary**: the Python plugin shells out to `scripts/*.py`, passing
JSON on stdin and reading JSON on stdout. Therefore:

1. **Reimplement the store logic in TypeScript against the IDENTICAL JSON
   schema** — snake_case keys preserved verbatim: `id`, `content`, `kind`,
   `source`, `created_at`, `supersedes`, `superseded_by`, `note`.
2. **Keep the bridge plugin in Python** (it has to be — it's a Hermes plugin
   hook) and re-point its subprocess calls from `sys.executable <script>.py`
   to `node <ts-cli>.mjs` (or `bun <ts-cli>.ts`).
3. The store data files stay **byte-compatible**. A store written by the Python
   impl must be readable by the TS impl and vice versa. This is the acceptance
   test for every ported module.

## 4. Contract to preserve (from `memory.py` + `test_memory_core.py`)

- **Fact fields** (snake_case on disk):
  - `id` — 12 hex chars = `randomBytes(6).toString("hex")`
  - `content` — string
  - `kind` — one of `memory | user | identity | directive`
  - `source` — string
  - `created_at` — `YYYY-MM-DDTHH:MM:SSZ` = `new Date().toISOString().slice(0, 19) + "Z"`
  - `supersedes` — string[]
  - `superseded_by` — `""` = active; `"retracted"` sentinel = removed, no successor
  - `note` — string
- **Store file shape**: `{"version": 1, "facts": [{...}]}`, `JSON.stringify(_, null, 2)`.
- **Semantics**:
  - `add(content, kind, source, supersedes?, note?)`: append fact; for each
    supersedes id, mark that active fact's `superseded_by = new.id` (conflict
    flagged, never destroyed).
  - `retract(id, source?)`: set `superseded_by = "retracted"` only if active;
    append `"retracted by <source>"` to `note`.
  - `history(id)`: walk `superseded_by` forward to newest, then `supersedes`
    backward to oldest; reverse → oldest..newest. Guard cycles with a seen-set.
  - `active(kind?)`: filter `!superseded_by`.
  - `export()`: active facts grouped by kind (sorted), values are content strings.
  - `mutate(fn)`: acquire cross-process lock → `reload()` → run `fn(store)`.
- **Locking**: Python uses `flock` on `<store>.lock`. **Node has no flock in
  stdlib.** Need a cross-process lock: lockfile with `O_EXCL` (`openSync(path,
  "wx")`) + retry loop + stale detection (mtime), or `proper-lockfile` dep.
  Single-host, and Python/TS never run concurrently (plugin points at one
  script family at a time), so no mixed-mode interop is required.
- **Wire format** (`profile_io.py`): `MEMORY.md`/`USER.md` split/join on `§`;
  `join_entries` refuses content containing `§`. Port verbatim
  (`SEPARATOR = "§"`).
- **Six test cases to port** (`test_memory_core.py`): add+active-filter,
  supersede-flags-never-destroys (+ `history` chain), persistence-roundtrip,
  invalid-kind-rejected, profile-derived-view-roundtrip, join-refuses-separator.

## 5. Conventions (axiom `AGENTS.md`, still binding)

Erasable TypeScript only (no enums/namespaces/parameter-properties), no `any`,
NodeNext with `.ts` specifiers (Node 26 type-stripping does not rewrite `.js` →
`.ts`), no inline/dynamic imports, no emojis in commits.
Tests via `node --test` (Node 26 runs `.ts` natively).

## 6. Plan (todo state at stop)

1. [x] Inventory the sovereign layer
2. [x] Confirm toolchain
3. [x] Scaffold the TS package (`package.json` type=module, tsconfig, typescript devDep)
4. [x] Port `memory.py` → `memory.ts`
5. [x] Port `test_memory_core.py` → `memory.test.ts`, run green
6. [ ] Port the scripts (`ingest`/`query`/`record`) as TS CLI entrypoints
       (`profile_io.py` already ported → `src/profile_io.ts`)
7. [ ] Port the skills store (`skills.py`, `skill_io`, `skill_bridge`, `sync_skills`, `decide_skills`)
8. [ ] Re-point the `native-store-bridge` plugin subprocess calls at the TS CLI
9. [x] Re-found `axiom-agent` on Hermes HEAD + archive prime-agent

## 7. Next steps tomorrow morning (in order)

1. Decide the TS package's physical home. Proposed:
   `/home/mustbearn/Projects/axiom-sovereign/` (cheap to rename; the eventual
   re-foundation into `axiom-agent` is todo #9). Do NOT touch the existing
   `axiom-agent` repo contents yet.
2. `npm init -y` + pin `typescript`; tsconfig with erasable-TS-friendly settings
   (module NodeNext, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, strict).
3. Write `src/memory.ts` (port §4 above) + `test/memory.test.ts` (6 cases).
4. `node --test` → green; `tsc --noEmit` clean.
5. Continue down §6.

## 8. Open questions for the operator (not blocking)

- ~~Confirm the new package home/name~~ — resolved 2026-08-16: folded into
  `axiom-agent/axiom/sovereign/`.
- Node vs bun for the CLI runtime: bun starts ~10x faster, which matters for a
  subprocess-per-write; node is more portable. Recommend **bun for the CLI
  entrypoints, node for the library/tests**.
