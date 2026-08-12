# ADR-0031 — Mermaid diagrams as Unicode art in the terminal transcript

## Status
Accepted (2026-08-12)

## Context
Assistant messages frequently contain ```mermaid fences; in the terminal
they rendered as raw source inside a highlighted code block, which most users
cannot read as a diagram. Upstream prime-agent tracks the same gap (issue
#1244: render mermaid as inline Unicode art, using the grok-mermaid port of
xAI's terminal renderer). Evaluation: a third-party dependency (grok-mermaid)
is young and registry-snapshot-fragile; terminal graphics protocols (kitty /
iTerm2 inline images) are supported by the TUI for tool output but only in a
subset of terminals (disabled under tmux/screen/vscode/alacritty by
capability detection), and cannot be verified headlessly.

## Decision
1. Implement an in-repo TypeScript renderer (`src/core/mermaid-art`) for the
   flowchart/graph subset: lenient parser (shapes, labelled solid/dotted/
   thick edges, single-level subgraphs; unsupported diagram types rejected;
   parseable prefix survives), rank-based layout, box-drawing output with
   per-line art roles (border/edge/node/label/title).
2. Add a width-aware `transform` hook to the pi-tui Markdown component
   (applied after tab normalization, before parsing; render cache keyed on
   its output) — the upstream-proposed seam.
3. Wire mermaid fences through `transformMermaidBlocks` in assistant text
   blocks (not thinking blocks) and user messages, themed per role
   (border dim, edge accent, title dim+bold); fall back to raw source when
   the diagram is unsupported, unparseable, wider than the terminal, or the
   feature is disabled.
4. Gate the feature behind a settings toggle (`/settings` > Mermaid diagrams,
   default ON; persisted via settings-manager; takes effect after reload),
   matching the upstream proposal of a rendering mode toggle.

Not chosen: terminal graphics-protocol image rendering (terminal-dependent,
not headless-testable) and grok-mermaid (external, snapshot-fragile).

## Consequences
Terminal users see readable diagrams inline for the common flowchart subset;
everything outside it degrades gracefully to the raw fence. The transform
hook is a general seam for future pre-parse rendering. Known v1 limits:
multi-edge label collisions on shared routing rows; no sequence/gantt/etc.
diagram types; subgraphs are single-level. The renderer is pure and unit-
tested (24 tests) and the full flow is PTY-verified.
