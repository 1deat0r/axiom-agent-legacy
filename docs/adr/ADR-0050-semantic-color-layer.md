# ADR-0050: Semantic color layer (model-facing markdown color descriptors)

**Status:** accepted
**Date:** 2026-08-14
**Extends:** ADR-0002 (TUI architecture), ADR-0032 (TUI markdown rendering), ADR-0017/0020/0021 (gateway transports)

## Context

The TUI renders model markdown through the `Markdown` component
(`packages/tui`) with a theme (`getMarkdownTheme`). Models have no way to
color a span: emphasis is structural, so "this failed" and "this passed" can
only differ in words. A model-facing color contract lets the model mark spans
semantically without coupling to ANSI: the TUI resolves roles and hexes to
terminal colors, and every other surface (Telegram HTML, Discord, Slack) must
never show the descriptor syntax.

## Decision

A pseudo-link grammar on markdown link hrefs, parsed by
`parseColorDescriptor` (`packages/tui/src/color-descriptor.ts`):

- `[text](#role:NAME)` foreground role and `[text](#bg:NAME)` background
  role. Roles: error, warn, ok, info, accent, muted (`ROLE_NAMES`).
- `[text](#hex:RRGGBB)` / `[text](#hexbg:RRGGBB)` exact hex colors.
- A standalone `#RRGGBB` token (word boundaries) colors itself and appends a
  swatch chip in the TUI. A `/` or `.` immediately before the token blocks it,
  so URL fragments (`http://x.com/#aabbcc`) stay plain. The ambient style is
  applied to the literal and the chip before the color wrap, so heading and
  blockquote weight survives.
- Channels compose: bold and strike render inside the colored span, because
  the renderer colors the fully-rendered inner tokens. Underline has no
  inline markdown token in the renderer (theme.underline applies to links,
  headings, and the default style), so it stays out of scope until an
  underline inline token exists.

Four layers (issue #25): base parsing (`feat/semantic-color`), TUI link
rendering (`feat/semantic-color-tui`), theme palette
(`feat/semantic-color-theme`: `ROLE_PALETTE` + `roleHex` + `colored` /
`backgrounded` on the interactive `MarkdownTheme`, truecolor and 256color),
and the contract layer. All four are composed and verified on
`feat/semantic-color-integration`, which this ADR ships with.

The contract layer has three parts:

- **Model guidance** — `buildMarkdownColorGuidance()` in
  `core/system-prompt.ts` teaches the model the grammar in both the default
  RLM prompt and the custom (gateway profile) prompt path.
- **Gateway strip** — `stripColorDescriptors()` (packages/tui, exported
  from pi-tui) strips color pseudo-links to their inner text on every
  non-TUI surface: Telegram (before the markdown-to-HTML pass and before
  chunking, so a long link split across chunks cannot leak its descriptor),
  Discord `send`, Slack `send`. The strip normalizes the text exactly like
  the TUI renderer's lexing path (tabs to three spaces, CRLF to LF) and
  lexes with the renderer's own marked parser. It walks the token tree
  shape-aware (list items and table cells hold content in `items` /
  `header`+`rows`, not `tokens`) and splices two token kinds into the
  source in document order: a link whose href parses as a color descriptor
  reduces to its inner raw text, and a link reference definition line is
  removed (the TUI renders definitions as nothing). The splice cursor
  always advances past each child, so an identical raw string quoted
  earlier inside preserved content (a code span, a fence, an HTML block, a
  link title) is never hit instead of the real link. Parity is by
  construction - inline and fenced code, reference resolution, escape
  handling, blockquotes, lists, tables, indented code, and label whitespace
  collapse all follow the TUI because they are the TUI's parser. Known
  residual divergences, all out of the color grammar: non-color reference
  links keep their raw markdown on the gateway while the TUI shows them as
  resolved links (pre-existing gateway markdown behavior); a hard break
  inside a color link keeps its trailing spaces on the gateway while the
  TUI collapses them (HTML rendering collapses them anyway); the TUI's
  narrow-width table fallback can render a cell raw where the strip has
  already reduced it. Internal records (delivery ledger, stream journal,
  session files) keep the raw text — the strip is a presentation rule, not a
  logging rule.
- **ADR + term** — this document plus the CONTEXT.md `Semantic color` term.

Unknown role names, uppercase roles, malformed hexes, and `#RGB` shorthand
are NOT color descriptors: the TUI renders them as plain links and the strip
keeps them, so nothing is ever silently recolored or dropped. The model
always writes the visible meaning inside the brackets.

## Consequences

- Models can mark spans semantically; non-TUI surfaces degrade to clean text
  because the meaning lives in the visible inner text.
- One parser is the single source of truth: `parseColorDescriptor` gates
  both the TUI renderer and the gateway strip, `parseHexLiteral` validates
  every candidate literal the renderer's tokenizer proposes, and the strip
  itself lexes with the renderer's own marked parser - the two surfaces
  cannot drift on link or code recognition.
- Gateway code never emits ANSI; the contract is TUI-only by definition.
- Prompt cost: the guidance adds a short section (71 words, ~100 tokens) to
  every system prompt, including gateway profiles, where the tags are
  stripped — the cost is accepted for one shared grammar across surfaces.
