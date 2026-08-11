# TUI v2: the full-screen session view

ADR-0012 records the decision to give the TUI a full-screen rendering mode
("the session view") that matches the terminal UX of modern agent CLIs
(prime-agent's pi-tui vocabulary: persistent header, markdown-rendered
transcript, live activity indicators, command palette with autocomplete),
while keeping axiom's zero-dependency, core-UI-free architecture.

## Decisions

- **The session view is a new surface mode, not a rewrite of the line loop.**
  When stdin is a TTY and the terminal is wide/tall enough (≥60 cols, ≥12
  rows), `axiom tui` runs the full-screen view; otherwise it falls back to
  the battle-tested line mode (`Tui` class). Same stores, same agent, same
  command palette — only the rendering changes.
- **Full repaint, never incremental erase.** Every frame is assembled from
  state and written as `\x1b[2J\x1b[H` + the frame. The box-menu ghosting
  wound came from height-based erase math; a full repaint has no erase math
  and cannot ghost. The spinner ticks by repainting the same way.
- **The core stays UI-free.** The view subscribes to the agent's events
  exactly like the line mode does. All rendering is pure:
  `markdown.ts` (block/inline rendering), `frame.ts` (state → screen),
  `palette.ts` (command autocomplete + input history). The driver
  (`session-view.ts`) is a thin raw-mode controller over an injectable IO
  seam (stdin keys, stdout writes, timers, terminal size), so every line is
  testable without a TTY — the 100% coverage bar applies to the whole tree.
- **Input is a small raw-mode line editor.** Printable insert at the
  cursor, backspace/delete, left/right, home/end, up/down history,
  ctrl+w word-delete, ctrl+u clear, ctrl+l repaint, Tab/arrows cycle the
  palette, Enter submits, ctrl+c quits (the agent run itself cannot be
  cancelled — no abort signal — so ctrl+c exits and the session persists,
  restartable; a cancellable run is future work).
- **The command palette is one vocabulary** (ADR-0005): the view completes
  against the same commands `routeCommand` parses, in `surface/commands.ts`
  — never a second list.
- **The wizard is a modal that leaves raw mode.** `/providers` still runs
  the canonical-mode box wizard (battle-tested since v0.21): the view
  drops raw mode, writes its final frame, runs the wizard on a fresh
  readline interface, then re-arms raw mode and repaints. The wizard is
  the only flow that mode-switches.
- **Live cost is on screen.** The header shows session + lifetime spend
  (via the shared `sessionLedger`, ADR-0011) and the spend cap when set;
  each completed run gets a dim footer line (`— 1.2s · $0.0006 —`). The
  money thesis is the first thing the eye lands on.
- **100% coverage is a hard gate.** `npm run coverage:check` runs the
  whole suite with `--test-coverage-lines/branches/functions=100`; the
  tree stays at 100% or the gate fails. Entry scripts gain injection seams
  (`runCli`/`runTui` take io) so even the boot paths are tested in-process.

## Alternatives considered (and rejected)

- **Adopt pi-tui / an Ink-style TUI framework.** It is the reference UX but
  pulls a dependency tree (chalk, marked, …) into a project whose soul is
  "small and typed to the bone"; the needed surface (header, markdown-lite,
  palette, activity) is a few hundred lines of pure ANSI, testable to the
  last branch.
- **Keep line mode and only add a status bar.** Cheaper, but it stays a
  chat in a scrolling log; the ask was a full-screen session view.
- **Raw-mode box-menu everywhere.** The v0.23 prune removed exactly this
  (ghost/leak wounds); the session view's full-repaint discipline is the
  safe replacement, and the wizard stays canonical.
