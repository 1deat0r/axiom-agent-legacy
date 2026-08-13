# ADR-0039 — Pause the Telegram poll while a reply is delivered

## Status
Accepted (2026-08-13)

## Context
Every single-message reply took ~30s on the live gateway even with the fast
model, and the streaming edits timed out at 15s (`stream edit failed: The
operation was aborted due to timeout`). Reproduction pinned the mechanism:
with a `getUpdates` long-poll open, Telegram holds CONCURRENT bot calls
(sendMessage/editMessageText) until the poll returns — the gateway's loop
re-opens a 30s long-poll immediately after each message, so the reply's edits
queue behind that window. The reply landed only when the poll expired: a 3s
completion + 27s of queued delivery.

## Decision
The gateway pauses the transport's poll loop while a reply is being
delivered, and resumes it after:

- `GatewayTransport` gains optional `pausePolling()`/`resumePolling()`
  (send-only fan-out transports and Signal have no poll to hold).
- `TelegramTransport.pausePolling()` aborts the in-flight long-poll and keeps
  the loop idle (a paused loop waits on a resume promise instead of spinning);
  `resumePolling()` releases it. `disconnect()` resumes so a paused loop can
  observe `stopped` and exit.
- The gateway wraps every outbound burst in pause/resume: the denial reply,
  command replies (including the deferred `/update` action), the streaming and
  batch agent-reply paths, and `/announce` fan-out.

Messages arriving while a reply is in flight simply wait in Telegram's queue
and are delivered on the next poll — the gateway already serializes per
channel, so nothing is lost. The 15s HTTP timeout stays as a safety net for
genuine hangs.

## Consequences
- Single-message replies land at completion speed (~3-6s), not poll-window
  speed (~30s).
- Poll aborts during replies are silent (no transient-error log spam); a
  paused loop waits, never busy-loops.
- Discord/Slack poll the same way and may share the queueing behavior — they
  get the same pause when verified live; cron deliveries still go out without
  a pause (fire-and-forget, ≤30s invisible delay; recorded follow-up).
