# ADR-0074: Native web search core tools — web_search and web_fetch

Status: accepted
Date: 2026-08-15

## Context

Web search today runs through two skills. Obscura is first: a local Rust
headless browser behind an MCP server, keyless, with browser automation.
Serper is the fallback: a keyed Google API. Neither is a core tool, so web
access has no first-class shape in the agent registry and no offline-testable
seam.

The goal is a native, keyless web search capability in the core that beats
the Obscura path on latency and token cost, matches it on result quality and
freshness, and stays testable without network access. Metrics ranked, not a
strict all-metrics bar: latency and token cost lead; quality and freshness
need parity; keyless and testable are hard requirements.

Observed on 2026-08-15: the DuckDuckGo html endpoint serves an anomaly
challenge from this network. Bing serves parseable results. A single-engine
tool would be dead here; the chain below is what keeps the tool alive.

## Decision

Two core tools, registered like read and write:

- `web_search` — query plus optional result count. Scrapes DuckDuckGo html
  first, then Bing, then drives the local Obscura MCP browser as the last
  hop (browser_navigate + browser_evaluate per engine, duckduckgo, bing,
  google). Returns one compact JSON block of `{rank, title, url, snippet,
  date?}`.
- `web_fetch` — url plus optional char cap. Gates the URL through
  `checkUrlSafetyPinned` and connects with the gate-owned `fetchPinned`
  (ADR-0057, ADR-0066). Converts HTML to markdown in-repo. Falls back to
  Obscura (browser_navigate + browser_markdown) when the page yields no
  parseable content.

Caps (the token-cost win): snippet 200 chars, results 10 max (default 5),
fetch content 20000 chars default, hard truncation, no raw HTML in output.

Safety: every engine host and every fetch URL passes the URL gate. Private,
loopback, and link-local addresses stay blocked. No domain allowlist in v1.

Behavior: in-run result cache (same query or URL in one turn is served from
cache), one-second minimum spacing between requests to the same engine host,
honest user agent `Axiom/<version>`. All hops fail = tool error with reason.

Config: env vars `AXIOM_WEBSEARCH_TIMEOUT_MS` (default 8000),
`AXIOM_WEBSEARCH_MAX_RESULTS` (default 5), `AXIOM_WEBFETCH_MAX_CHARS`
(default 20000), `AXIOM_WEBFETCH_TIMEOUT_MS` (default 15000). Settings keys
`webSearch` and `webFetch` mirror them. The Serper skill keeps its legacy
`AXIOM_WEBSEARCH_TIMEOUT` and `AXIOM_WEBSEARCH_NUM_RESULTS` names.

Replacement policy: the native tools are first choice for search and plain
fetch. The Obscura skill keeps browser automation and hard-page fetch. The
Serper skill stays optional for keyed users.

## Consequences

- Search and fetch become testable offline through injected seams: engine
  fetchers, fallback, gate, fetcher, clock. Live behavior is covered by a
  live-gated suite.
- The tools are network egress: S-class per the merge gate. A 9-case attack
  corpus covers SSRF literals, scheme and credential attacks, DNS rebinding
  flips, pin pass-through, and cap enforcement.
- `fetchPinned` has no built-in timeout or header override. The tools race a
  timeout around it and use a small pinned fetcher that overrides headers and
  destroys the socket on abort. Follow-up: signal and header support in the
  gate itself.
- Live verification (2026-08-15): the native DuckDuckGo scrape and the
  Obscura MCP fallback both work from this network. The Obscura search
  fallback composes browser primitives on one MCP session, matching the
  python client.
- Deferred: robots.txt handling for `web_fetch`, time and region filters,
  on-disk caching, fetch rate limiting.
