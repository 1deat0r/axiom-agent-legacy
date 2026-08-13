# ADR-0041 — Bound channel session growth so replies stay fast (session budget)

## Status
Accepted (2026-08-13)

## Context
On 2026-08-13 the live gateway's channel session had grown to ~508k real
tokens (a 2.6MB JSONL, 647 entries, zero compactions) and every
single-message reply took about a minute, even on the fast model. The
mechanism: each agent run re-processes the whole session as its context, so
provider prefill — and therefore time-to-first-word — scales with session
size. The baseline's auto-compaction is a window-pressure safety net: it
fires only near the provider's context window. The active model
(deepseek-v4-pro) advertises a 1M-token window, so a ~508k-token session
can never trigger compaction — the session could keep growing toward the
window with every reply getting slower on the way. A timed live run
confirmed the diagnosis: the same model answered a fresh session in ~5.3s.

## Decision
The gateway bounds how large a channel session may grow before it is
archived and the next run starts fresh (issue #22):

- Soft cap `GATEWAY_SESSION_BUDGET_BYTES = 256KB` of JSONL in
  `src/gateway/session-reset.ts` — roughly tens of thousands of real tokens
  once tool payloads are counted. `sessionExceedsBudget(path)` reads the
  file size before each run; a missing or unreadable file reads as within
  budget, so the check can never block a reply.
- Archive in place: `archiveSessionFile` renames `<id>.jsonl` to
  `<id>.jsonl.archived-<ts>` (same directory, `renameSync`). The archive
  keeps its history for recall, and the search indexer accepts archived
  names and indexes them under a derived id (`<id>.archived-<ts>`) so
  `/search` and `/sessions` still find the old conversation, and the archive
  can never collide with the live file that shares its header id (commit
  41966e660).
- Fresh start: after the archive, the next run for the channel writes a
  brand-new session file at the same path, so the agent boots with no
  history — the operator keeps the channel, loses only the carried context.
- The reset rides the reply: `SESSION_RESET_NOTICE` prefixes the reply — the
  first streamed edit and the batch fallback both carry it — so the operator
  sees why the channel's memory was archived. A failed archive is swallowed
  (best-effort) and the reply proceeds on the still-oversized session rather
  than blocking.
- On-demand reset: the `/new` command archives the current session through
  the command surface (`ctx.resetSession` -> `resetChannelSession`, project
  and generation aware) and reports a one-line result; a second `/new` with
  nothing to archive reports "no session to reset".

## Consequences
- Replies stay at completion speed no matter how long a channel has been
  talking; time-to-first-word no longer scales with session size on
  big-window models.
- Long-lived channel memory is deliberately bounded: past the cap the old
  conversation becomes recall material (`/search`, `/sessions`), not carried
  context. The busiest channels trade continuity for latency.
- Archives accumulate in the sessions directory (one file per reset); there
  is no garbage collection yet — recorded follow-up.
- Auto-compaction stays for small-window models; the budget is an additional
  floor that fires first on big-window models, and never disables
  compaction.
