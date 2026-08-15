# Handoff: native web search core tools (issue #50, ADR-0074)

## What was done

Two native core tools, `web_search` and `web_fetch`, in
packages/coding-agent/src/core/tools/. They are the first-choice web path.
The Obscura skill keeps browser automation and the Serper skill stays the
keyed fallback.

- web_search: DuckDuckGo html scrape, then Bing, then the local Obscura MCP
  browser (navigate + evaluate, engines ddg/bing/google). Compact JSON
  block, snippet cap 200, results cap 10 (default 5), total block cap 4000.
- web_fetch: URL gate (checkUrlSafetyPinned + fetchPinned, ADR-0057/0066),
  in-repo HTML to markdown, hard 20k char cap, Obscura markdown fallback.
- In-run cache per tool instance, one-second per-engine spacing, user agent
  Axiom/<version>, timeouts via a pinned fetcher that destroys the socket.
- Env: AXIOM_WEBSEARCH_TIMEOUT_MS, AXIOM_WEBSEARCH_MAX_RESULTS,
  AXIOM_WEBFETCH_MAX_CHARS, AXIOM_WEBFETCH_TIMEOUT_MS. Settings webSearch and
  webFetch. Serper keeps its legacy env names.
- Registered in core/tools/index.ts, sdk.ts, cli/args.ts BUILTIN_TOOL_NAMES,
  active by default (sdk default list + agent-session default list).
  Regressions 4428 and 3592 updated for the new registry.

## What was verified, and how

- Unit: 34 tests across test/tools/ (parsers, chain, cache, rate limiter,
  validation, registration) - all green. Parsers verified against real
  captured engine markup (fixtures in test/tools/fixtures/).
- S-class corpus: 9 cases in test/tools/web-threat-corpus.test.ts (SSRF
  literals, scheme and credential attacks, DNS flip, pin pass-through, cap
  enforcement) - all green, offline.
- Live (AXIOM_LIVE_WEB=1, not in the neutral floor): 5 tests green - real
  DuckDuckGo scrape from the pinned fetch, real page fetch, real Obscura MCP
  fallback (search compose + markdown fetch + forced-fallback chain).
- Floor: ./test.sh = 5750 passed / 14 failed = 13 documented EXDEV known
  fails (4603x4, 4685x9) + kernel-attach-image-skill shard flake that
  passes standalone 9/9. biome clean (3 pre-existing gateway infos), tsgo
  clean.
- Worktree needed a real node_modules copy (not the symlink): the symlink
  breaks 114 suites in this sandbox, and the copy resolves @earendil-works
  packages to the worktree, so packages ai/agent/tui were built in the
  worktree first. models.generated.ts regen was reverted.

## Limitations (recorded in ADR-0074)

- fetchPinned has no built-in timeout or header override; the tools race a
  timeout and destroy the socket. Follow-up: signal support in the gate.
- Deferred: robots.txt for web_fetch, time and region filters, on-disk
  caching, fetch rate limiting.
- The Obscura fallback opens a fresh MCP session per call (about 10s per
  hop). A session pool is a possible follow-up.
