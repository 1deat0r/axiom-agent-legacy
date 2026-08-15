# ADR-0082: Session recall — /search over a persistent FTS5 index

**Status:** accepted
**Date:** 2026-08-15
**Issue:** #56 (ADR-0082 reservation)
**Implements:** ADR-0078 port order (session recall, the step after /learn)
**Extends:** ADR-0001/0004/0006 (gateway architecture), ADR-0008 (memory tool — recall covers what the durable-fact tool cannot)
**Note on ceremony:** written under the restructure execution rules (ceremony
override) — the record bats at the milestone, like ADR-0078.

## Context

The capability named by issue #56 shipped before the issue existed. The
gateway port (ADR-0001/0004/0006) landed cross-session search on main across
three commits on 2026-08-12/13 — `bb6c7ce1c` (the FTS5 module), `996b47bfd`
(persistent index, `--offset` scroll, `/sessions` browse), `41966e660`
(archived session files stay searchable). When the ADR-0078 spine issues were
cut on 2026-08-15, #56 reserved ADR-0082 for the record. This ADR closes that
loop: it records what shipped and why, instead of re-implementing.

## Decision

1. **Recall surface = `/search` + `/sessions`.** `/search <q>` ranks matching
   messages across the profile's session archive (append-only JSONL under the
   sessions dir); `/sessions` browses recent sessions, newest-first. Both are
   gateway-local (ADR-0001) — they never reach the model.
2. **FTS5 (trigram) over the real JSONL corpus, node:sqlite only.** The index
   is a persistent SQLite DB reconciled incrementally by file size+mtime, so
   repeated searches never rescan the archive; WAL journal; FTS5 triggers keep
   the virtual table in sync with `entries`. No new dependency (Node >= 22.8
   stdlib). The vendored `session-backends/sqlite-node` is dist-only and
   unreferenced by src — wiring it would be a large un-mergeable blast radius,
   so the fork indexes the archive it actually persists.
3. **Project isolation, labeled.** A session belongs to a project iff its
   header `cwd` is under `<projectHome>/projects/<name>`. Anchored runs scope
   to that project by default; `--all` crosses explicitly; every hit carries
   its project label, so projects never silently mix. Unanchored runs treat
   the profile as one workspace.
4. **Bounded and resilient.** Caps: 2000 session files, 64KB per session,
   4KB per message, 3-char minimum query (the trigram floor). Malformed JSONL
   lines are skipped, never fatal; query text is phrase-escaped against FTS5
   injection.
5. **Wired end to end.** `commands/index.ts` registers both commands, `/help`
   documents them, and the CLI threads `projectRoot`, `sessionsDir`, and
   `searchIndexPath` (per-profile `search/session-recall.sqlite`) through the
   gateway context.

## Consequences

- Recall answers "what did we decide about X" from the raw transcript — the
  complement of the memory tool's explicit durable facts (ADR-0008): the
  memory tool stores what the loop chose to keep; `/search` finds what it
  said.
- Per-file metadata reconciliation keeps append-only growth cheap: an
  unchanged file costs a stat, not a parse.
- Out of scope (follow-ups): live incremental append indexing, index rebuild
  tooling, and ranking beyond FTS5 bm25 + recency.
- Verification: 21 gateway tests (11 session-search, 10 search-command) green
  under vitest; the full floor runs at the merge milestone.
