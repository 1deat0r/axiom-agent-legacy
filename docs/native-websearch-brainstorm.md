# Native web search core tool - brainstorm

Status: round 2 open. Date: 2026-08-15.
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
  The sdk wires them (sdk.ts exports createReadTool, createWriteTool).
- Settings already carry enabledTools and disabledTools lists. These control
  tool availability.
- The security fence lives in packages/coding-agent/src/extensions/security/
  url.ts (ADR-0028, ADR-0057, ADR-0066). checkUrlSafetyPinned(url, options)
  returns a block verdict or an allow verdict with a pinned DNS resolution.
  A gate-owned fetchPinned connects to the pinned addresses with the original
  Host header. Private, loopback, and link-local addresses block by default.
- The MCP client lives in packages/coding-agent/src/core/mcp/mcp-manager.ts.
  It is the natural seam for the Obscura fallback hop.
- Precedent for direct node fetch exists in core/model-registry.ts.
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

Round 1 (settled, user approved all recommendations):
- Q1 premise: yes. Native core tool. Keyless. Self-contained.
- Q2 metric order: ranked. Latency and token cost lead. Quality and
  freshness must equal Obscura. Keyless and testable stay hard.
- Q3 scope: (b) search and fetch. Two tools: web_search and web_fetch.
  Browser control stays in Obscura.
- Q4 replacement: (a) native first. Obscura keeps browser control and acts
  as the fetch fallback for hard pages. Serper stays optional.
- Q5 search backend: (a) direct scrape of DuckDuckGo HTML and Bing. Fall
  back to Obscura when a page yields no results.

Round 2 (frontier, open):
- Q6 location and names: core tool registry vs built-in extension.
- Q7 result schema: compact blocks, caps, date field.
- Q8 safety: gate every fetch through checkUrlSafetyPinned plus fetchPinned.
- Q9 config surface: settings keys and env vars, no collision with Serper.
- Q10 cache and rate limits: in-run cache, per-engine spacing, user agent.
- Q11 fallback chain: DuckDuckGo, Bing, Obscura MCP, error with reason.

Round 3 (after round 2): verification. Recorded fixtures vs live tests.
S-class threat corpus. ADR plus CONTEXT.md term plus issue with readiness
contract.

## Round 2 questions

Q6 Location and names.
Put the two tools in the core tool registry at
packages/coding-agent/src/core/tools/ (web-search.ts, web-fetch.ts) with the
same factory pattern as read and write: createWebSearchTool plus
createWebSearchToolDefinition, createWebFetchTool plus
createWebFetchToolDefinition. Wire them in sdk.ts. The existing settings
lists enabledTools and disabledTools then control them. The other option is
a built-in extension (src/extensions/web) like peers and git-guard.
Recommend: core tools. Web access is a first-class agent capability, same
class as read and write. Extensions are for opt-in or anchored features.

Q7 Result schema.
web_search returns one compact JSON block: [{rank, title, url, snippet,
date}]. Caps: snippet 200 chars, results 10 max, default 5. web_fetch
returns {url, title, content}. Content is markdown. Default cap 20000 chars.
Both tools truncate hard. They never dump raw HTML. The date field appears
only when the engine provides one.
Recommend: yes, those caps. The caps are the token-cost win.

Q8 Safety.
web_fetch pushes every URL through checkUrlSafetyPinned from
extensions/security/url.ts and connects with the gate-owned fetchPinned.
That keeps the ADR-0057 DNS checks and the ADR-0066 rebind pinning. Private
and loopback addresses stay blocked by default, same as Obscura. web_search
fetches only the fixed engine hosts, also through the gate. No domain
allowlist in v1. The open web is the point.
Recommend: yes. Gate every fetch, search included.

Q9 Config surface.
Settings plus env vars. The names AXIOM_WEBSEARCH_TIMEOUT and
AXIOM_WEBSEARCH_NUM_RESULTS already belong to the Serper skill. The native
tool must not reuse them. New names: AXIOM_WEBSEARCH_TIMEOUT_MS,
AXIOM_WEBSEARCH_MAX_RESULTS, AXIOM_WEBFETCH_MAX_CHARS. Timeout defaults:
search 8 seconds, fetch 15 seconds. Settings keys mirror them under
webSearch and webFetch.
Recommend: yes, new names. Serper keeps its legacy pair. The ADR documents
the split.

Q10 Cache and rate limits.
Cache in-run only. The same query in one turn returns the cached result. No
disk cache in v1. Per-engine spacing: at least one second between requests
to the same engine host. Honest user agent: Axiom/<version>. robots.txt for
web_fetch: defer to a follow-up issue.
Recommend: yes.

Q11 Fallback chain.
web_search scrapes DuckDuckGo html first, then Bing, then calls the local
Obscura MCP search through core/mcp/mcp-manager.ts when both yield no
results. web_fetch uses the native parser first and falls back to Obscura
only for pages the parser cannot read (JS-only pages). When all hops fail,
the tool returns an error with the reason.
Recommend: yes.
