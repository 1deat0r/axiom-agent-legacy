# ADR-0023: Cross-transport fan-out (one run reaches every channel)

**Status:** accepted (autonomous decision, owner-empowered, 2026-08-12)
**Relates to:** ADR-0022 (delivery ledger + within-transport fan-out), ADR-0017/
0020/0021 (transports), ADR-0001/0006 (gateway architecture), ADR-0015
(prime-agent baseline). Issue #3 "Gateway breadth — more transports +
continuity": closes the "fan out to every channel" (platform-wise) gap.

## Context

ADR-0022 gave `/announce` and `deliverToAll` a fan-out primitive, but it was
single-transport: the router owns one active transport, so targets could only
be channels on that transport. The issue's "a delivery ledger makes one run fan
out to every channel" and Hermes' "delivery to many channels from one run"
imply reaching channels across platforms. This ADR extends fan-out so a
`deliverTo` target may name a transport, and the gateway can hold extra named
send-only transports to reach it.

## Decisions

1. **`deliverTo` entries may name a transport.** Each target becomes
   `{ transport?: string; channel: string }`; `transport` defaults to the active
   transport. Parsing is permissive (non-string `transport`/`channel` dropped)
   and back-compatible (existing `{ channel }` configs keep working).
2. **The gateway holds extra named fan-out transports.** `GatewayDeps` gains
   `transports?: Record<string, GatewayTransport>` — send-only targets a
   `deliverTo` entry's `transport` name can address. `deliverToAll` resolves
   each target: a named transport we hold is used and the ledger entry is
   labelled with that transport; an absent/unknown named transport degrades to
   the active transport and the ledger is labelled with the transport that
   actually delivered (never a phantom name).
3. **CLI builds siblings from present tokens.** `buildFanOutTransports` ships in
   `gateway-command.ts`: every platform OTHER than the active transport whose
   token is present (`AXIOM_*_BOT_TOKEN` or its flag) is built as a send-only
   fan-out transport. A platform with no token is simply absent — graceful, and
   deterministically tested; the single-platform default is unchanged.
4. **Send-only, never connected.** Fan-out transports are used only for
   `send`; they are not `connect()`ed (their poll/receive loop stays idle), so
   no extra receive surface or lifetime is implied. Cross-platform fan-out is
   real when the operator configures sibling tokens, and inert-by-config (not
   dead code behind a fake) otherwise.

## Consequences

- `config.json` `deliverTo` can now mix transports, e.g.
  `[{ "transport": "slack", "channel": "C1" }, { "channel": "C2" }]`, so
  `/announce` and a `/cron` spine run can reach Discord, Slack, and Telegram
  channels in one fan-out. Every delivery is ledgered with the delivering
  transport's name (`/ledger` shows the platform).
- Data/token story unchanged: each platform still uses its own token env; fan-out
  targets only exist when the operator enables that platform (token present).
  Back-compat configs work unchanged.
- **Known limitations (recorded, not built):** a fan-out target's send failures
  are recorded `ok:false` by the transport's own logging, not fatal to other
  targets; live cross-platform verification is operator-gated (needs tokens for
  more than one platform). Websocket/Socket-Mode realtime and relay/mirror
  continuity remain separate follow-ups.
- **Baseline drift (recorded):** branch is merged current with the baseline tip
  (see ADR-0022); routine merges continue under AGENTS.md cadence.
- Test suite grows: cross-transport fan-out routing + ledger labelling + CLI
  sibling construction (gateway dir now 19 files / 167 tests).
