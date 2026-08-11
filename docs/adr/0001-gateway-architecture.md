# Gateway architecture: channel-mapped sessions over pluggable transports

The gateway connects the UI-free agent core to external messaging platforms. It maps one stable `channelId` to one Axiom `Session` — mirrored into the session's `meta` so a restart re-attaches — and treats every platform as a pluggable `Transport` driven through a normalized, platform-agnostic message shape.

## Decisions

- **One channelId == one Session.** The first message on a channel starts a session; later messages on the same channel continue it. The mapping lives in memory and is mirrored into session `meta`; on restart the gateway re-attaches by scanning sessions for a matching `channelId`.
- **Raw-text boundary.** The gateway never formats platform UI — it sends the agent's plain text answer and lets the transport adapt it. *(Deliberate no: keeps the gateway platform-agnostic.)*
- **Commands are gateway-local.** Messages flagged `isCommand` are handled by the gateway itself and never reach the model.
- **Streaming across the transport is opt-in (see ADR-0004).** The final answer is sent once the agent loop settles — unless the target transport opted into live deltas, in which case the deltas are the answer and the batch send is the fallback guarantee. *(Superseded for the agent loop by ADR-0003, and for opted-in transports by ADR-0004; the raw-text boundary is untouched.)*
- **Transport contract.** Platforms plug in via `connect` / `disconnect` / `send` / `onMessage`. Two transports ship today: the in-process `InMemoryTransport` and the dependency-free `HttpTransport` (POST-webhook inbound, JSON-POST outbound).

## Status

accepted

## Consequences

- Restart re-attachment is O(1) through the channel resume index (see ADR-0006); the meta-scan remains only as the migration fallback for pre-index Sessions.
- Every surface emits structured events through the shared typed `Emitter` in the core, so observers (operators, dashboards) attach the same way on CLI, TUI and gateway.
