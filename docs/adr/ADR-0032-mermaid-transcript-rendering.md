# ADR-0032 — Mermaid diagrams as Unicode art in the terminal transcript

## Status
Accepted (2026-08-12), routing revised (2026-08-13)

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
2. Route edges on reserved lanes: runs live in the gutters between ranks
   (which grow when more lanes are needed than rows/columns available), and
   back edges / rank-skipping edges route around the diagram via outside
   lanes, entering the target's side with the arrowhead on the box edge.
   Corners landing on another edge's line render as T-junctions; labels ride
   on their edge's line or beside a run and never overwrite box borders,
   other labels, or structural route markers. The grid grows to fit frames
   and outside lanes, then re-checks the width cap.
3. Add a width-aware `transform` hook to the pi-tui Markdown component
   (applied after tab normalization, before parsing; render cache keyed on
   its output) — the upstream-proposed seam.
4. Wire mermaid fences through `transformMermaidBlocks` in assistant text
   blocks (not thinking blocks) and user messages, themed per role
   (border dim, edge accent, title dim+bold); fall back to raw source when
   the diagram is unsupported, unparseable, wider than the terminal, or the
   feature is disabled.
5. Gate the feature behind a settings toggle (`/settings` > Mermaid diagrams,
   default ON; persisted via settings-manager; takes effect after reload),
   matching the upstream proposal of a rendering mode toggle.

Not chosen: terminal graphics-protocol image rendering (terminal-dependent,
not headless-testable) and grok-mermaid (external, snapshot-fragile).

## Consequences
Terminal users see readable diagrams inline for the common flowchart subset;
everything outside it degrades gracefully to the raw fence. The transform
hook is a general seam for future pre-parse rendering. The renderer is pure
and unit-tested (26 renderer/parser tests plus transform/settings/TUI tests)
and the full flow is PTY-verified in the real TUI.

Remaining v1 limits: flowchart/graph subset only (sequence/gantt/pie/state
fall back raw); single-level subgraphs (nested subgraphs flatten into the
enclosing frame); the toggle applies to messages rendered after reload.
