# Transport-level streaming: capability opt-in, best-effort deltas, batch as guarantee

ADR-0003 froze the gateway transport boundary. This ADR reopens it for text deltas: a transport can opt in with `supportsStreaming` + `sendDelta`, and the gateway then forwards each `text_delta` from the agent run live. Streaming is best-effort — the final batch `send` remains the delivery guarantee and the fallback.

## Decisions

- **Capability opt-in.** `GatewayTransport` gains two optional members: `supportsStreaming?: boolean` and `sendDelta?(partial: GatewayMessage, chunk: string): Promise<void>`. `partial.text` is the cumulative text as of that delta; `chunk` is the new fragment. The transport owns its delivery policy — edit a single bubble in place (the Telegram/Signal pattern) or deliver each fragment — the gateway neither knows nor cares.
- **Per-run subscription.** During `agent.run` the gateway subscribes to the agent's events and forwards each `text_delta` to the opted-in transport, emitting a `message_delta` GatewayEvent per chunk. The subscription is torn down in `finally`.
- **Batch send is the guarantee.** The gateway sends the full message on completion unless deltas streamed cleanly (then the transport already has the answer). Non-streaming providers, non-streaming transports, and delta delivery failures all fall back to the batch send; a failed delta stops streaming, and the duplication on that rare path is accepted over lost delivery.
- **HttpTransport defines its streaming wire shape (see ADR-0004 follow-up).** With `streaming: true` it opts in: every outbound POST carries an explicit `delta` field — `true` for live fragments (cumulative `text`), `false` for terminal messages (batch final or the `sendDeltaEnd` stream-completion signal). Default construction stays batch-only.
- **`message_out` unchanged.** Observers still see exactly one `message_out` per turn with the completed message; `message_delta` is the additive streaming view.

## Status

accepted

## Consequences

- An opted-in transport must tolerate never seeing a final `send` for streamed turns — its deltas are the answer.
- The raw-text boundary (ADR-0001) holds: the gateway ships raw text, now in fragments.
