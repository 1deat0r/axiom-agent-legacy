# Native web search core tools

Branch feat/native-websearch. Issue #50. ADR-0074. Merged 2026-08-15.

Design record: docs/native-websearch-brainstorm.md (grilling rounds 1-3).

Two keyless core tools replace the Obscura skill as the first-choice web
path: `web_search` (DuckDuckGo scrape, Bing, Obscura MCP fallback) and
`web_fetch` (SSRF-gated pinned fetch, in-repo HTML to markdown, Obscura
fallback for unparseable pages). S-class threat corpus: 9 permanent attack
cases. Live suite (AXIOM_LIVE_WEB=1) exercises the real engines and the
real Obscura MCP protocol.

Verification record: docs/handoff-websearch-native.md.
