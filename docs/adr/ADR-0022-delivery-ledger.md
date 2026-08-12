# ADR-0022: Delivery ledger + fan-out (gateway continuity)

**Status:** accepted (autonomous decision, owner-empowered, 2026-08-12)
**Relates to:** ADR-0001/0006 (gateway architecture), ADR-0020/0021 (Discord +
Slack transports). Issue #3 "Gateway breadth — more transports + continuity",
the **continuity** half.

## Context

Issue #3's transports are in (Telegram ADR-0017, Discord ADR-0020, Slack
ADR-0021). The other half is continuity: "a delivery ledger makes one run fan
out to every channel — which the automation spine can then feed." Axiom's
router already owns the single outbound path, so the smallest faithful slice is
(1) an append-only **delivery ledger** recording every outbound delivery
(reply, denial, command reply, fan-out), and (2) a **fan-out primitive** on the
router that delivers one message to every configured channel on the active
transport — the "one run reaches every channel" behavior, with a gateway-local
`/announce` to drive it and `/ledger` to audit it. Cross-platform
multi-transport fan-out and the cron spine feeding `deliverTo` are follow-ups
(recorded, not built).

## Decisions

1. **Delivery ledger (ADR-0022).** `delivery-ledger.ts` defines `DeliveryEntry`
   (ts, transport, channel, recipient, chars, ok, error) and a `DeliveryLedger`
   interface (`record`, `recent(n)`). `MemoryDeliveryLedger` is the test-safe
   default (capped at 1000); `FileDeliveryLedger` appends JSONL under
   `<AXIOM_HOME>/gateway/ledger.jsonl`, seeds from the file on construction
   (continuity across restarts), skips a malformed line rather than failing,
   and keeps the same in-memory cap so `recent` never re-reads the file.
2. **The router records every delivery.** `Gateway.deliver(to, text)` is now the
   single outbound path; every reply, denial, and command reply runs through it
   and is recorded (ok=false if the transport throws — never silent). Existing
   tests construct the router without a ledger, so recording is off by default
   there and the blast radius stays contained.
3. **Fan-out primitive.** `Gateway.deliverToAll(text)` reads the active
   transport's `deliverTo` channels from the shared config.json, sends to each
   through the ledgered path, and returns the channel count. `GatewayConfig`
   gains `deliverTo?: { channel: string }[]` (parsed permissively; non-string
   entries dropped; a config with only senders still works — back-compat).
4. **`/announce` and `/ledger` commands.** `/announce <text>` fans one message
   out via `deliverToAll` (fire-and-forget — the fan-out is async and the
   command dispatch stays synchronous); `/ledger [n]` lists the last n recorded
   deliveries. The command context gains optional `ledger` + `deliverToAll`,
   supplied by the router; commands are unchanged in shape, so the sync
   dispatch is preserved.
5. **CLI wiring.** `defaultGatewayStart` passes a `FileDeliveryLedger` (at
   `<AXIOM_HOME>/gateway/ledger.jsonl`) and the transport name so each entry is
   labelled (e.g. `telegram`, `discord`, `slack`).

## Consequences

- Every outbound delivery is auditable (`/ledger`) and one message fans out to
  every configured `deliverTo` channel (`/announce`), the "continuity"
  primitive the automation spine can feed.
- Data lives under `<AXIOM_HOME>/gateway/ledger.jsonl`, carrying the ADR-0015
  data-cutover rules. config.json gains an optional `deliverTo` list; existing
  configs keep working.
- **Known limitations (recorded, not built):** fan-out is single-transport (the
  router owns one transport); the subscription / automation spine (cron)
  delivering a run's result through `deliverTo` on this branch is a follow-up
  once the branch rebases onto the cron baseline; `/announce` is fire-and-forget
  (confirms immediately, audit via `/ledger`), not awaited by the command; a
  `deliverTo` channel the bot cannot send to is recorded ok:false by the
  transport's own logging rather than failing the fan-out.
- **Baseline drift (recorded):** branch remains cut from `baseline/prime-v0.7.2`
  @ 01948fe39 (see ADR-0020); routine baseline merge brings it current.
- Test suite grows with ledger + fan-out coverage: delivery-ledger (5),
  config deliverTo (1), gateway-ledger (3), gateway dir now 18 files / 143 tests.
