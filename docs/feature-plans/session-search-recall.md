
# Plan — Cross-session recall `/search` (gateway command over an FTS5 index)

**Goal (one sentence):** A gateway-local `/search <query>` command that answers "what did we
decide about X in a past session?" by full-text (FTS5) searching the agent's session archive,
scoped to the anchored project by default and to the whole profile only via an explicit, guarded
`--all`, with each result labeled by its project so projects never silently mix.

**Success criterion:** `/search <q>` returns ranked matching sessions/messages; an anchored run
never returns hits from another project unless `--all` is given; `./test.sh` green, biome clean,
tsgo clean.

**Assumptions (reviewers check these):**
- "session DB" = the on-disk session archive this repo actually persists: append-only JSONL files
  in the profile's sessions dir. The vendored `session-backends/sqlite-node` (a different "canonical
  session database" model) is dist-only, has no package.json/src, and is unreferenced by src — wiring
  it would be a large, un-mergeable blast radius. We build the FTS5 index over the real JSONL corpus.
- FTS5 via the `node:sqlite` stdlib (Node >=22.8; verified on v26.4.0, trigram tokenizer available).
  No new dependency, no network.
- Project isolation: a session belongs to a project iff its header `cwd` is under that project root
  (`<projectHome>/projects/<name>`). Anchor comes from `--project` (already resolved to projectRoot in
  the CLI); the gateway currently drops projectRoot — we thread it through.

## Files
- NEW `src/gateway/session-search.ts`: scan sessions dir -> per-message doc; build in-memory FTS5 index
  (trigram); safe query; rank; project helpers (`isWithin`, `projectLabelForCwd`). Pure, injectable.
- NEW `src/gateway/commands/search.ts`: parse `/search [--all] [--limit N] <q>`; call search; render reply
  (Telegram-safe chunking); enforce the project guard.
- EDIT `src/gateway/commands/index.ts`, `help.ts`: register `/search`, document it.
- EDIT `src/gateway/types.ts`: extend `GatewayCommandContext` with `projectRoot?`, `sessionsDir?`.
- EDIT `src/gateway/gateway.ts`: thread deps -> context.
- EDIT `src/cli/gateway-command.ts`: resolve production sessionsDir, pass projectRoot + deps.
  (In-memory index per call -> no on-disk index file; sessionsDir is the only corpus path.)
- NEW tests `test/gateway/session-search.test.ts`, `test/gateway/search-command.test.ts`.

## Ordered steps (each paired with verification)
1. Session search module + its test -> run vitest session-search.test.ts.
2. Gateway command + plumbing + its test -> commands/search-command.test.ts green.
3. Wire CLI production paths -> gateway-command.test.ts still green.
4. `biome check .` clean; `tsgo --noEmit` clean; `./test.sh` green -> commit.

## Test strategy
New: index-build/query ranking (red-green), FTS injection safety, trigram 3-char minimum, project
isWithin/label, `--all` guard (anchored plain search never crosses), unanchored help, empty/malformed
JSONL resilience. Existing: gateway commands/gateway/telegram suites run unchanged.

## Risks
FTS5 special chars in query (phase-quote + double-quote + backslash escape); <3-char queries (friendly
message); large archives (caps: max 2000 session files, per-session 64KB, per-message 4000 chars; matched
message text retained in the doc so we can render a snippet); deterministic tests (temp dirs, injected
paths/io, no live env); node:sqlite availability on the Node floor (verify under the vitest transform, not
just `node -e`, before relying on it in tests). Persistence/incremental indexing is an explicit follow-up,
not v1.

## Self-review (rubric) — weaknesses found & fixed
1. RISK/CLARITY: plan named a `searchIndexDir` but the in-memory-per-call design has no index file.
   Removed it (dead weight / contradiction).
2. RISK: performance + snippet rendering were unspecified. Added explicit caps (2000 files, 64KB/session,
   4KB/message) and stated matched text is stored in the doc so a snippet renders.
3. TESTABILITY: node:sqlite only verified in `node -e`. Added a step to confirm it under the vitest
transform before committing tests to it.
4. CORRECTNESS: 'profile' semantics for an unanchored default run were ambiguous. Stated that 'profile'
means the passed `sessionsDir` corpus and results are labeled by project via cwd when derivable, else
'workspace'.
