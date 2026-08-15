# ADR-0047 — Stream long replies across multiple Telegram bubbles instead of one oversized edit

## Status
Accepted (2026-08-14)

## Context
Streaming replies (streaming v2, ADR-0004/#6) place a "…" placeholder and
edit it in place as deltas arrive. Telegram caps `editMessageText` at 4096
characters; when a reply grows past the cap the edit is rejected, the
streamed bubble freezes at its last landed text, and the final edit
(which also exceeds the cap) fails, so the reply visibly breaks. Long
answers either never land or force the batch fallback.

The fix must keep the streaming UX (bubble edits in place, instant
first-token feedback) while letting a long reply span several messages.

## Decision
Give `StreamEditor` a per-bubble length cap and a rollover hook:

- `maxTextLength?: number` — the most characters one bubble may show.
- `rollover?: (overflow: string) => Promise<void>` — called (in order)
  when the current bubble hits the cap. The editor commits the current
  bubble at the cap, advances its internal window, and hands the caller
  the overflow text so it can open a fresh placeholder bubble.
- `remainingText(): string` — the unlanded tail of the current bubble;
  the batch fallback sends exactly this (earlier bubbles are already on
  screen).

`StreamEditor` tracks a `bubbleStart` window into the full target text.
When a `setTarget` would exceed the cap, the pump commits the current
bubble at the cap, advances the window, awaits `rollover(overflow)`, and
leaves the new bubble untouched until the next `setTarget` (or
`finish()`, which first rolls any pending overflow and then lands the
final tail). Commit-edit failures are logged but never fatal — the
stream keeps moving so the final tail still lands.

The gateway wires the hook to Telegram: `rollover` sends a new "…"
message, journals it (same stranded-bubble recovery as the first
bubble), and re-points the editor's `edit` closure at the new messageId.
`STREAM_BUBBLE_MAX_LENGTH = 4000` leaves headroom under Telegram's 4096
cap. The final-edit fallback now delivers `remainingText()` (or the full
text when the tail was absorbed by earlier bubbles) via the existing
chunked batch path.

Separately, the gateway's session budget stopped archiving the session
file at 256KB (which wiped memory before the child's autocompaction
could engage) and instead passes `--compact-before` to the completion
child, which summarizes the existing context in place and resumes on the
small session — autocompaction instead of archive.

## Consequences
- Replies stream across N bubbles; each bubble stays under the cap, so
  Telegram never rejects an edit for length.
- The rollover API is transport-agnostic: `StreamEditor` knows nothing
  about Telegram; the hook is injected by the gateway.
- 5 new red-first rollover tests (cap commit, second-bubble rollover,
  unlanded tail for the batch fallback, finish-with-pending-overflow,
  failed-edit resilience); the oversized-session gateway test now asserts
  the session is kept and the run is flagged compactBefore.
