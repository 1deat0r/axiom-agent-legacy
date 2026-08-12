# Handoff — Mermaid diagrams in the terminal transcript (ADR-0031)

## What
Assistant/user ```mermaid fences now render as box-drawing Unicode art
inline in the interactive transcript, behind a /settings toggle ("Mermaid
diagrams", default ON, takes effect after reload). Unsupported diagram types,
unparseable input, and diagrams wider than the terminal fall back to the raw
fence. No external dependency: the renderer is in-repo TypeScript.

## Where (branch feat/mermaid-render, merged to main d868ee5b8)
- src/core/mermaid-art/ — lenient flowchart parser + rank-based layout +
  box-drawing drawer with per-line roles (border/edge/node/label/title),
  width cap. 18 tests.
- src/core/mermaid-transform.ts — fence -> themed art (border dim, edge
  accent, title dim+bold); 6 tests.
- packages/tui Markdown — width-aware transform hook (post-normalization,
  pre-parse; cache keyed on its output); 3 tests.
- settings-manager + settings-selector — mermaidRendering toggle (default
  true, persisted via save()); 2 tests.
- assistant-message (text blocks, not thinking) + user-message wire the
  transform with the setting; interactive-mode threads the value.

## Verified how
- Unit: 24 new renderer/transform tests + 2 settings + 3 tui; full ./test.sh
  4632 passed, ONLY the documented sandbox known-fails (14: daemon-serialized
  refine, 4603x4, 4685x9); biome + tsgo clean.
- PTY (tmux): real TUI launched; /settings menu shows "Mermaid diagrams
  true"; Space toggles to false; earlier the same probe proved /pro menu
  behavior. End-to-end Markdown demo renders a real flowchart with themed
  border/edge rows.

## Known limits (v1)
- Flowchart/graph subset only (sequence/gantt/pie/state/etc. fall back raw).
- Label collision when two edges share a routing row (cosmetic).
- Single-level subgraphs only.
- Toggle applies to messages rendered after reload (documented in the menu).
- Image-tier rendering (kitty/iTerm2) not built; the transform seam exists
  if wanted later.

## Not done
- The Profiles & Projects interactive menu (queued separately).
