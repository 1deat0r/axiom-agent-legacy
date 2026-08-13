# Gateway streaming v2 — smooth, serialized, recoverable Telegram streaming

Date: 2026-08-13 · Branch: feat/gateway-streaming-v2 · ADR: ADR-0004/#6 (extension, no new ADR)

## Problem

The first streaming cut (per-delta `editMessageText`) worked but felt slow and
glitchy and could strand a frozen bubble:

- every text delta fired an unawaited edit with the full accumulated text —
  unbounded API flood (429s) with zero ordering guarantees, so an older edit
  could land after a newer one and visually regress the bubble;
- when the stream ended exactly on the final text no final edit was sent, but
  in-flight stale edits could still clobber it afterward — no recovery;
- a gateway restart mid-stream (deploy / self-update / systemd) left the "…"
  placeholder forever — the "you just stopped messaging" case;
- no typing indicator while the model thought before the first token.

## What changed

- `packages/coding-agent/src/gateway/stream-editor.ts` (new): `StreamEditor` —
  coalescing, strictly serialized in-place edits. At most one edit in flight,
  ≥120ms spacing (first update immediate), transient-only retries (429/5xx with
  backoff), `finish()` drains and applies the final text without the spacing
  throttle, reports whether the bubble ended on the final text.
- `packages/coding-agent/src/gateway/stream-journal.ts` (new): JSONL in-flight
  stream journal under `<AXIOM_HOME>/gateway/streams.jsonl` +
  `recoverInterruptedStreams`, wired into `axiom gateway` boot — a stranded "…"
  bubble is edited into an interruption notice on the next start.
- `packages/coding-agent/src/gateway/gateway.ts`: streaming path now drives the
  `StreamEditor`, journals the bubble for the stream's lifetime, and pings
  `sendChatAction("typing")` every 4s until the first delta (batch path pings
  until the reply lands). Final-edit failure still falls back to one fresh
  message.
- `packages/coding-agent/src/gateway/transports/telegram.ts` + `types.ts`:
  `sendChatAction` on the transport contract and the Telegram client/transport;
  `sendMessage`/`editMessage` moved onto the transport contract as optional
  capabilities.

## Verification

- 57 new/updated gateway tests: editor ordering/coalescing/drain/retry,
  journal round-trip + recovery, typing cadence, in-flight journal lifecycle.
- Full `./test.sh`: 4741 passed; the 16 failures are the documented sandbox
  known-fails (4603×4, 4685×9, daemon-serialized-refine×1) plus two real-kernel
  flakes (4428, kernel-agent-message) that pass standalone. biome + tsgo clean.

## Deploy

Rebuild `packages/coding-agent`, restart the canonical gateway systemd unit.
First restart cannot recover bubbles from the old code (they were never
journaled); every stream after this deploy is recoverable.
