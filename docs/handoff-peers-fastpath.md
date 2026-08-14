# Handoff: peers turn-start peek stat-based fast path (issue #30)

Branch `feat/peers-fastpath` (isolated worktree `.worktrees/peers-fastpath`,
cut from origin/main = 6de570a2d). ADR not required (performance fix to the
ADR-0038 mechanism, per the issue).

## What was done

The peers extension ran `peekInbox` on every `turn_start`: read the cursor
file, stat the board, slice it, and JSON-parse the tail — even when nothing
had changed since the last turn.

1. `core/peers/board.ts`: new `BoardFileStat` (size + mtimeMs) and an
   injectable `statFile` dep; `boardStat(scope, deps)` stats the board
   file (missing board = empty stat).
2. `core/peers/peers.ts`: `peekInbox(scope, identity, cache?, deps?)`
   short-circuits when the board stat has not moved since the caller's
   last peek (size AND mtime equal) — returns no messages without reading
   or parsing the board or the cursor file. The cache snapshots the stat
   (never aliases an injected object). `inboxMessages` threads the board
   deps so tests drive everything in memory. The board is append-only, so
   an unchanged stat means no new line can have landed; the full unread
   set stays available via `peers_inbox`, and a cold cache (CLI
   invocation, first turn) always reads.
3. `extensions/peers/index.ts`: one `PeekCache` per run (extension
   closure); `turn_start` passes it, so the same unread message is no
   longer re-notified on every turn.

## What was verified

- 4 new tests red-first: skip-on-unchanged (asserts zero reads after the
  warm-up peek), re-read on size-only and mtime-only changes, new-messages-
  then-quiet, and an extension-level test that a second `turn_start`
  does not re-notify while a fresh board write does.
- Peers suites 46/46 (core/peers/*, extensions/peers, peers-command);
  biome clean on the touched files; `tsgo --noEmit` clean.
- Full ./test.sh: 5155 passed / 15 failed — 14 are the documented sandbox
  known-fails (daemon-serialized-refine x1, 4603 x4, 4685 x9 EXDEV); the
  15th (sdk-session-manager) is a parallel-shard flake that passes
  standalone 3/3.

## Merge state

Pushed to origin; merge pending.
