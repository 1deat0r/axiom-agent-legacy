# Surface vocabulary consolidation: one Command palette module

ADR-0002 deferred sharing the Command palette between the CLI and the TUI until "maintenance actually bites". It bit: the palettes drifted — an unknown `/x` line is help in the TUI but a model message in the CLI, `/exit` is accepted but undocumented, help text exists in two divergent copies, and session/memory/skill list formatting is triplicated. This ADR consolidates the vocabulary into one `src/surface/` module.

## Decisions

- **One `src/surface/` module owns the vocabulary.** `routeCommand` (including the unknown-command → help rule), the unified help text, the ANSI color helper, and the session/memory/skill list-row formatters. The CLI and the TUI both delegate; neither owns vocabulary.
- **The model never sees a command-shaped line.** An unknown `/x` is help on every surface. (Fixes the CLI's previous behavior of sending it to the model.)
- **`/exit` is accepted and documented** everywhere.
- **`src/surface/` is not core.** The agent core stays UI-free by design; the vocabulary is a surface concern with its own seam, named after the domain term (Surface).
- **Supersedes ADR-0002's "keep separate palettes" bullet.** The surfaces keep their own loops and I/O; only the vocabulary is shared.

## Status

accepted

## Consequences

- A palette change now edits one file and lands on every surface at once.
- CLI `USAGE` covers flags only; `/help` inside the session prints the shared command help.
