# Session budget — bound channel context so replies never wait on prefill

Date: 2026-08-13 · Branch: main (shipped in c1d2ef9a6) · ADR: ADR-0041

## Problem

The live gateway's channel session grew to ~508k real tokens (2.6MB, 647
entries, zero compactions) and every reply took about a minute. Each run
re-processes the whole session as context, so prefill scales with session
size. Auto-compaction only fires near the provider's context window, and the
active model (deepseek-v4-pro) has a 1M-token window — at ~508k tokens the
session could never compact, and would only get slower with every reply. A
timed live run proved it: the same model answered a fresh session in ~5.3s.

## What changed

- `src/gateway/session-reset.ts` (new): `GATEWAY_SESSION_BUDGET_BYTES`
  (256KB soft cap), `sessionExceedsBudget` (missing/unreadable file reads as
  within budget, never blocks), `archiveSessionFile` (rename in place to
  `<id>.jsonl.archived-<ts>`), `SESSION_RESET_NOTICE`.
- `src/gateway/gateway.ts`: before each run, an over-budget session file is
  archived and the reset notice prefixes the reply (first streamed edit and
  batch fallback both carry it); a failed archive never blocks the reply.
  `/new` archives on demand via `resetChannelSession` (project and
  generation aware).
- `src/gateway/commands/new.ts`: `/new` command surface
  (`ctx.resetSession`); `/help` advertises it.
- Search indexer (commit 41966e660, follow-up fix): accepts
  `.jsonl.archived-<digits>` names and indexes them under a derived id
  (`<id>.archived-<ts>`) so `/search` and `/sessions` still find archived
  conversations, and an archive never collides with the live file sharing
  its header id.

## Verified

- Unit: `test/gateway/gateway.test.ts` — "archives an oversized session
  before a run and notes the reset in the bubble" and "/new archives the
  channel session via the command surface" (second `/new` reports "no
  session to reset"). Full `./test.sh` at the feature commit passed with
  only the documented sandbox known-fails.
- Live: the gateway unit was restarted with the new source and the
  over-budget 2.6MB session was archived on the next message; the reset
  notice was observed in the reply. The archive then vanished from `/search`
  until commit 41966e660 taught the indexer archived names.
