# TUI architecture: pure decision layer, interactive shell, adapter bridge

The TUI is the interactive terminal surface for the UI-free core. Its logic is split into a pure, testable decision layer — `renderEvent` (one `AgentEvent` → display lines) and `routeCommand` (a `/command` line → a `CommandAction`) — under a thin interactive loop (`Tui.run` over `node:readline`), joined to a real `Agent` by an adapter bridge (`bindAgentTui`) that streams events live via `subscribe`.

## Decisions

- **Pure decision layer, injected I/O.** Rendering and command routing are pure functions; the `Tui` class takes an injectable `execute` runner plus optional list callbacks, so a headless consumer (or test) exercises the surface without a TTY.
- **Live rendering via subscribe, final print only when not already rendered.** The bridge subscribes for the duration of each run and renders every event as it lands, reporting `renderedLive: true` on the result; the loop prints the final answer only when the runner did not render it. Output ownership is unambiguous at each layer.
- **Command palette in one place.** `routeCommand` owns the vocabulary (`/new`, `/sessions`, `/memory`, `/skills`, `/help`, `/quit`); an unknown `/x` line is help, never a message.
- **CLI and TUI share one palette (superseded by ADR-0005).** Originally kept separate — coupling two different surfaces over a common module was deferred until maintenance bit. It bit (the palettes drifted: unknown `/x` went to the model in the CLI, `/exit` went undocumented); ADR-0005 consolidates the vocabulary into `src/surface/` while each surface keeps its own loop.
- **No dead command surface.** `CommandAction` carries only what the palette routes; the `arg` field was removed as speculative generality, and `/switch` waits for real session-switching UX.

## Status

accepted

## Consequences

- A consumer who wants both live rendering and a final print must render deliberately; the bundled bridge chose live-only, and the earlier double-print (live render + loop print of the same assistant text) is closed by the `renderedLive` contract.
