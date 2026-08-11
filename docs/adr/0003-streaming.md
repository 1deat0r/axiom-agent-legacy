# Streaming: optional streamChat provider path, text_delta events, frozen transport boundary

The agent loop originally always used a single-shot provider call, and ADR-0001 recorded streaming as a deliberate no. Streaming is now an optional provider capability: a provider implementing `streamChat` feeds the loop token deltas as they arrive; the loop forwards them as `text_delta` events and otherwise behaves exactly as before. The gateway transport boundary stays frozen — transports still receive one final message per turn.

## Decisions

- **Optional `streamChat` on the provider.** `LLMProvider` gains `streamChat?(params): AsyncIterable<StreamChunk>` (SSE: `stream: true`, `delta.content` / aggregated `delta.tool_calls`, `[DONE]`). A provider without it — tests, simple backends — keeps working with zero deltas. `chat` remains the single-shot path. (Preserves the provider-agnostic principle.)
- **`text_delta` AgentEvent.** One additive event per text chunk (`{ type: 'text_delta', sessionId, content }`). The terminal `assistant` event is unchanged — persistence, gateway batch sends, and existing renderers are untouched; consumers opt in by subscribing.
- **Always stream when supported.** The loop prefers `streamChat`, buffers tool-call argument fragments (the provider concatenates fragments per call index), and emits the full `assistant` on completion. One code path, no mode-splitting; `finish` arrives as a typed chunk so finish-reason mapping stays in the provider.
- **Transport boundary: opt-in (superseded by ADR-0004).** Originally frozen — the gateway sends one final message and the transport contract stays non-streaming. ADR-0004 reopens the boundary via capability opt-in (`supportsStreaming` + `sendDelta`); the batch send remains the guarantee and the fallback.
- **TUI renders deltas progressively.** The bridge writes `text_delta` tokens straight to stdout as they arrive and suppresses the bold terminal `assistant` line when a run streamed — the tokens already showed the answer, so re-printing it would duplicate. The readline-interleaving concern did not materialise: streaming output happens after the prompt resolves, so it lands on fresh lines and the next prompt is clean.

## Status

accepted

## Consequences

- Streamed runs may lack `usage` stats (the OpenAI stream omits usage unless `stream_options.include_usage` is set; not enabled).
- Consumers that want token-level UX subscribe to `text_delta`; consumers that don't are unaffected — the event is additive and the loop's observable contract (persisted history, terminal `assistant` event, `ChatResult`) is identical.
