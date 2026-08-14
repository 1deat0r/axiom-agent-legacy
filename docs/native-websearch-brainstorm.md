# Native web search core tool - brainstorm

Status: round 1 open. Date: 2026-08-15.
Worktree: /tmp/axiom-worktrees/native-websearch. Branch: feat/native-websearch.

## Facts found by the agent

- Axiom has no native web search tool. The core tool registry holds: bash,
  ipython, read, write, edit, code-preview, truncate. No web tool exists.
- Web search today runs through two skills. Obscura is first. Serper is the
  fallback. Both are skills, not core tools.
- Obscura is a local Rust headless browser. It runs as an MCP server at
  http://127.0.0.1:3000/mcp. It needs no API key. Its websearch call returns
  [{rank, title, url, snippet, engine}]. It uses DuckDuckGo first, then Bing,
  then Google. Its fetch call reads a page as markdown, text, links, or html.
  It also offers full browser control (navigate, click, fill, screenshot).
  The CLI has --stealth, --obey-robots, --proxy, and an SSRF block for
  private networks.
- The Serper skill needs an API key. The key lives in auth.json. Env
  overrides: AXIOM_WEBSEARCH_TIMEOUT, AXIOM_WEBSEARCH_NUM_RESULTS. Settings
  key bundledSkills.websearch (default true).
- Core tools use a factory pattern: createXTool plus createXToolDefinition,
  typed as AgentTool. Location: packages/coding-agent/src/core/tools/.
- ADR allocation rule (ADR-0071): reserve the lowest free number in the issue
  title at create time. Verify at merge. Open issues #48 and #49 hold
  ADR-0072 and ADR-0073. Next free number: ADR-0074.
- The merge gate (docs/agents/review-rubric.md) classes network-egress work
  as S-class. S-class work ships a threat corpus with 5+ attack cases. The
  dns-ssrf guard (issue #35) and rebind pinning (issue #43) are the existing
  network safety seams.
- Parallel work: issue #49 builds a grep tool plus an ast-grep skill in
  worktree /tmp/axiom-worktrees/search-meta. That is file-system search. It
  does not overlap this feature.

## Design tree

Root decision: do we build a native, keyless web search core tool that beats
the Obscura path on every metric?

Round 1 (frontier, open):
- Q1 premise: confirm the goal and the reading of meta-free.
- Q2 metric order: strict all-metrics bar, or a ranked order.
- Q3 scope: search only, search plus fetch, or search plus fetch plus browse.
- Q4 replacement policy: what happens to the Obscura and Serper skills.
- Q5 search backend: direct scrape, self-hosted SearXNG, or the Obscura API.

Round 2 (after round 1): tool shape and location (core tool vs extension,
one tool vs two, result schema), fetch backend, safety (reuse of the SSRF
guard, egress allowlist), config surface (settings keys, env vars), caching,
rate limits, polite crawl behavior.

Round 3 (after round 2): verification. Recorded fixtures vs live tests.
S-class threat corpus. ADR plus CONTEXT.md term plus issue with readiness
contract.

## Round 1 questions

Q1 Premise.
Build a native web search tool in the Axiom core. It must beat the Obscura
path on every metric: latency, result quality, freshness, token cost,
reliability, and testability. Reading of meta-free: no API key, no service we
host or pay for, no separate binary. The tool is self-contained in the core.
Recommend: yes. Native core tool. Keyless. Self-contained.

Q2 Metric order.
The strict bar is every metric. If strict, all six metrics are hard
requirements and the design must prove each one. If ranked, latency and token
cost lead. Quality and freshness must at least equal Obscura. Keyless and
testable stay hard requirements.
Recommend: ranked. Latency and token cost lead. Parity for quality and
freshness. Keyless and testable stay hard.

Q3 Scope.
(a) search only. (b) search and fetch. (c) search, fetch, and full browser
control. Option (c) keeps a browser role for Obscura.
Recommend: (b). Two tools: web_search and web_fetch. Browser control stays in
Obscura.

Q4 Replacement policy.
(a) native first. Obscura keeps browser control and acts as the fetch
fallback for hard pages. Serper stays optional. (b) native replaces Obscura
search fully and Serper is removed. (c) coexist with no priority change.
Recommend: (a). The native tool becomes the first choice for search and plain
fetch. Obscura stays for browser automation and hard-page fetch. Serper stays
optional for users who hold a key.

Q5 Search backend.
(a) direct scrape of DuckDuckGo HTML and Bing with native HTTP. No key. No
binary. Fastest. Engine markup changes can break it. (b) self-hosted
SearXNG. Stable JSON. Aggregates many engines. Needs a host we run and
maintain. (c) call the local Obscura MCP search from the core tool. Stable.
Still depends on the Obscura binary, so it is not truly native.
Recommend: (a). Scrape first. Fall back to Obscura when a page yields no
results. The fallback path covers the markup risk.
