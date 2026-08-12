# Handoff — Mermaid diagrams in the terminal transcript (ADR-0032)

## What
Assistant/user ```mermaid fences render as box-drawing Unicode art inline
in the interactive transcript, behind a /settings toggle ("Mermaid
diagrams", default ON, takes effect after reload). Unsupported diagram types,
unparseable input, and diagrams wider than the terminal fall back to the raw
fence. No external dependency: the renderer is in-repo TypeScript.

## Where (main)
- src/core/mermaid-art/ — lenient flowchart parser + rank-based layout +
  box-drawing renderer with per-line roles. Routing: rank-gap lanes that
  grow on demand; back/skip edges go around the diagram via outside lanes;
  corners over foreign lines become T-junctions; labels ride the line or
  sit beside a run and never eat borders/corners; growable grid with a
  final width-cap re-check. Parser flattens nested subgraphs without stray
  `end` warnings. 26 tests.
- src/core/mermaid-transform.ts — fence -> themed art (border dim, edge
  accent, title dim+bold); 6 tests.
- packages/tui Markdown — width-aware transform hook (post-normalization,
  pre-parse; cache keyed on its output); 3 tests (node:test).
- settings-manager + settings-selector — mermaidRendering toggle (default
  true, persisted via save()); 2 tests.
- assistant-message (text blocks, not thinking) + user-message wire the
  transform with the setting; interactive-mode threads the value.

## The 2026-08-13 finish pass (this handoff)
- Rewrote edge routing (render.ts): fixed back/upward edges that drew
  horizontal runs straight through the target box (and lost their arrowhead
  when the target sat at the grid edge), same-rank LR arrowheads that landed
  on the target's text row, LR advancing routes whose turn column landed
  inside a neighboring box, labels that overwrote box borders or vanished
  (upward-edge labels were drawn out of grid), and shared-row label
  collisions. Gaps now grow instead of colliding.
- Added junction/crossing glyphs (├ ┬ ┴ ┼ ╠ ╦ ╩ ...) with painter tracking so
  a corner replaces its own line but merges with foreign lines.
- Fixed the subgraph frame title clipping and title/border role priority
  (carried over from the prior session's uncommitted work), plus nested
  `subgraph`/`end` matching (no more bogus "unexpected 'end'").
- Fixed ./test.sh RED on main: packages/tui/test/markdown-transform.test.ts
  imported vitest but the tui package runs `node --test`; converted to
  node:test + node:assert.
- 26 renderer/parser tests (was 24), full ./test.sh 4639 passed with only
  the documented sandbox known-fails (15: daemon-serialized-refine,
  4603x4, 4685x9, kernel-agent-message-skill flake — the flake passes
  standalone); biome + tsgo clean.

## Verified how
- Unit: mermaid-art 26 + transform 6 + settings-selector 4 + tui 3.
- PTY (tmux): real TUI on a scratch AXIOM_HOME; asked the live model for a
  flowchart fence and the transcript rendered the themed diagram (diamond
  decision with yes/no labels); /settings shows "Mermaid diagrams true",
  Space toggles it to false.

## Known limits (v1)
- Flowchart/graph subset only (sequence/gantt/pie/state/etc. fall back raw).
- Single-level subgraphs (nested ones flatten into the enclosing frame).
- Dotted/thick junction glyphs reuse thin glyphs for mixed-style crossings.
- The toggle applies to messages rendered after reload (documented in the
  menu).
- Image-tier rendering (kitty/iTerm2) not built; the transform seam exists
  if wanted later.
