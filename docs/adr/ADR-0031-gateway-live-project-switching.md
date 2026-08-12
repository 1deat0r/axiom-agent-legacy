# ADR-0031 — Gateway live project switching with project-scoped sessions

- Status: accepted
- Date: 2026-08-12
- Related: ADR-0014 (profiles, projects), ADR-0015 (baseline), ADR-0030 (CLI
  command menu), ADR-0001 (gateway commands stay local)

## Context

The gateway's `/projects` command (ADR-0014) managed bare directories: it
listed, created, and removed workspaces under `<profileHome>/projects`, but a
project had no runtime meaning. Sessions were keyed by channel only, the
`--project` boot flag anchored the whole gateway to one project (with bwrap
confinement, fail-closed), and there was no way to switch projects live. The
one-line command output was also the user's complaint: "not user friendly,
legacy, no project-switching".

## Decision

Give projects runtime meaning, per chat channel:

- **Per-channel active project.** A persistent store
  (`<profileHome>/active-projects.json`, atomic rename writes, malformed-file
  self-heal — precedent: cron-jobs.json) maps channelId -> project. A chat
  switches live with `/projects use <name>`.
- **Project-scoped sessions.** When a channel has an active project, its
  session key AND session id derive from `channel:project:generation`
  (composite index key + deterministic FNV id). Each project gets its own
  conversation; switching back resumes it; the unanchored channel session is
  never leaked.
- **Anchored completions.** Agent messages on an anchored channel run with the
  project root as cwd + AXIOM_PROJECT_ROOT under the existing bwrap
  confinement (per-call `projectRoot` override in CliCompletionRunner,
  threaded through every anchoring point; fail-closed preserved).
- **Sessions die with the project.** `/projects rm` clears every channel
  mapping, bumps the project's generation (so a re-created project derives NEW
  session ids — the deterministic FNV hash would otherwise resume the pre-rm
  conversation from its surviving session file), and drops composite index
  mappings (removeWhere). Session FILES are not deleted: transcripts remain
  historical and /search-able.
- **Hardened rm.** `/projects rm` validates the name grammar AND contains the
  resolved target inside the projects root (fixes a pre-existing traversal:
  `rm ..` deleted the profile home).
- **Self-healing resolve.** A stored name that fails the grammar (hand-edited
  file) or a project deleted out-of-band is treated as stale: composite
  mapping dropped, store cleared, run unanchored — the menu never lies.

## Consequences

Telegram/Discord/Slack/Signal chats can now switch projects live and get
anchored, project-scoped work with per-project conversation memory. Unset
channels behave exactly as before (back-compat). Boot `--project` still anchors
the whole gateway; a per-channel active project overrides it for that channel.
Composite index keys accumulate per channel/project/generation (bounded,
harmless). Inline tappable keyboards (callback_query) for the menu are a
separate transport feature, deliberately not part of this change.
