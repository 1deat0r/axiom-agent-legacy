# Handoff — Cross-session recall `/search` (FTS5 over the session archive)

Branch: `feat/session-search-recall` (isolated worktree `.worktrees/session-search`).
Baseline: `baseline/prime-v0.7.2` @ `01948fe39`.

> **Status update (continuation):** the /search first step is now part of a structurally-complete
> feature. session-search.ts now keeps a **persistent incremental SQLite FTS5 index** (entries + sessions
> tables, FTS5 external-content + triggers, reconciled by file size+mtime, keyed by file path) — matching
> the card's "an FTS5 index over the SQLite session DB" and removing the per-call full rebuild. `/search`
> gained `--offset` (scroll/paging with stable order), and a new `/sessions` command provides the
> **discovery/browse** mode (newest-first, project-labeled, scoped like search). Committed as
> `996b47bfd`; gateway dir 103 pass (clean env), biome + tsgo clean. LLM-summarized recall is the
> remaining card item — a model-facing next phase (see below).

## What was done
Implemented a gateway-local `/search <query>` command (ADR-0001: never reaches the model) that
answers cross-session recall by full-text searching the agent's past session archive:
- NEW `packages/coding-agent/src/gateway/session-search.ts` — scans the profile sessions dir (append-only
  JSONL), extracts per-message text, builds an in-memory **FTS5** index (node:sqlite, trigram tokenizer),
  runs an injection-safe phrase query, ranks by bm25, and derives project labels. Project isolation:
  `isWithin` + `projectLabelForCwd`. Caps: 2000 files / 64KB per session / 4KB per message; 3-char min.
- NEW `packages/coding-agent/src/gateway/commands/search.ts` — `/search [--all] [--limit N] <q>` parsing
  and reply rendering.
- EDIT `gateway/types.ts`, `gateway.ts` — `GatewayCommandContext` gains `sessionsDir?`/`projectRoot?`,
  threaded from `GatewayDeps`.
- EDIT `cli/gateway-command.ts` — `resolveSessionsDir` (default vs named profile) + passes `projectRoot`.
- EDIT `gateway/commands/index.ts`, `help.ts` — register/document `/search`.
- NEW tests `test/gateway/session-search.test.ts` (6) and `test/gateway/search-command.test.ts` (7, incl.
  a full-router integration test proving 0 model calls).

Project isolation semantics: an anchored run (`--project`) searches only that project by default; `--all`
is the only cross-project path and every hit is labeled by its project; unanchored runs search the profile
as one workspace.

## What was verified, and how
- Unit (module + command, red-green, deterministic temp-dir fixtures): index build/rank, project scoping
  (beta excluded without `--all`; included + labeled with `--all`), unanchored whole-profile, `ftsPhrase`
  injection safety, `queryTooShort`, empty/malformed archives, `isWithin`/`projectLabelForCwd`, no-model-call
  integration.
- `node .../vitest ... test/gateway` = **97 pass** (clean env). `biome check` clean. `tsgo --noEmit` clean.
- Full floor (`npm test`, ~14 min): my two test files pass inside 322 passed suites. 30 failures across 9 files
  are **pre-existing environment/sandbox known-fails**, none from this diff: daemon/worker/self-update/recursion
  suites (the AGENTS.md-documented 4603/4685 EXDEV hard-link failures; plus 4600/4606, daemon-supervisor-process,
  daemon-serialized-refine-process, agent-session-recursion, package-command-paths), and ONE `gateway-command`
  "telegram, no token" test that is red **only** when `AXIOM_TELEGRAM_BOT_TOKEN` seeps into the environment —
  proven green with that var scrubbed (the baseline fails identically; `./test.sh` unsets it). Recorded as
  known-fail with reason, never muted.
- NOT live-tested: the production gateway requires a live Telegram bot token + bwrap, which this sandbox
  cannot run; production path wiring (`resolveSessionsDir`, `projectRoot` threading) is covered by unit tests
  and code review, not by a live end-to-end agent run.

## Follow-ups
- **LLM-summarized recall / memory surfacing** (the card's remaining item): a model-facing next phase —
  an agent-side `recall` tool (mirroring the memory-extension pattern) that surfaces top snippets for the
  model to summarize/decide. Not in this run because (a) gateway commands by ADR-0001 never reach the
  model, so a summary layer is an agent tool, not a gateway command, and (b) it needs a live model to be
  meaningfully verified, which the sandbox cannot run. Persistence (done) + browse + scroll (done) remove
  the infrastructure gap that unblocks it.
- Centralize the profile→agent-dir rule instead of `resolveSessionsDir` restating it.

## Note on review
The loop's external-review step was conducted as a cold "skeptical senior engineer" self-review (no separate
reviewer subagent was wired in this run); rubric total 92/100 (>=90 approve). See
`docs/feature-logs/summary.html`.
