# ADR-0014: Profiles, projects, and the anti-drift ladder

**Status:** accepted (owner design session, 2026-08-11)
**Extends:** ADR-0013's port queue (this design is the queue's next phase).

## Context

The baseline (pi v0.84.1) has implicit directory-scoped grouping — sessions
grouped by cwd, skills cwd-scoped behind a trust gate, AGENTS.md read from
the cwd — but no named projects, no profiles, and no memory tool.

The owner's vision, two parts:

1. **Axiom in the terminal should feel like the Hermes Desktop app** (Nous
   Research): chat-first, user-friendly for less technical users, guided
   onboarding, visible state — but fully in the terminal.
2. **The core /projects requirement is no agent drift**: people will run
   many projects in parallel with Axiom; the agent must never edit or act
   in the wrong project, or confuse one project's context with another's.

Verified facts:

- **Hermes profiles** (`hermes profile create coder`): a profile is a
  separate home directory (config, `.env`, SOUL.md, memories, sessions,
  skills, state). Each profile becomes its own command (`coder chat`).
  Hermes' hard rule: never point two agent processes at the same home —
  two writers on one home compound each other's state.
- **pi's confinement substrate**: a sandbox extension example (OS-level
  bash sandboxing via bubblewrap/sandbox-exec, per-project `.pi/sandbox.json`
  allow/deny write rules, built-in tool replacement seam); a container /
  micro-VM extension path (Gondolin, Docker); AGENTS.md loading; sessions
  stored per working directory.

## Decision

### Two levels, two drift boundaries

- **Profile = identity.** Hermes model: `~/.axiom/profiles/<name>/` holds
  SOUL.md, config, keys, memory, skills, sessions. `axiom --profile <name>`
  boots that identity; the profile's SOUL.md rides the system prompt.
  Cross-profile isolation is **process-level** (separate homes; Hermes'
  never-two-processes-on-one-home rule adopted). The default profile exists
  implicitly so beginners never see the concept.
- **Project = workspace, inside a profile.** A named binding to a root
  directory that owns its sessions (pi already cwd-groups them), its
  memory (per-project store), its ledger and cap (per-project), and its
  sandbox rules. Projects nest in profiles; a profile may run many
  projects in parallel.

### The anti-drift ladder

Drift is prevented by an enforcement ladder, not a prompt wish. Each rung
stops a specific failure mode:

1. **Identity (prompt):** "You are in project X, root at /path, never touch
   outside it" rides the system prompt; the TUI header shows the project
   prominently; switching renders a clear banner.
2. **Context (data):** the active project's memory is the only memory in
   context; its skills the only skills; its sessions the only sessions.
   Memory contamination becomes impossible, not just unlikely.
3. **Tool (enforcement — load-bearing):** a **workspace root guard** wraps
   bash/read/write: resolved paths outside the project root are blocked or
   routed to an explicit plain-English approval. Shipped built-in,
   zero-dependency (path checks at pi's tool-creation seam — the sandbox
   extension example proves the seam); pi's OS-level sandbox is the strict
   tier.
4. **Process (hard isolation):** profiles are separate processes/homes;
   pi's container/micro-VM path is the extreme tier.

Plus **visibility**: a per-project change summary (files changed, spend)
so drift can be seen and audited.

### Parallel model

One window, project tabs (the Hermes-desktop feel): sidebar lists projects,
each tab owns its context/memory/ledger, and the tool guard confines it. A
run and its message queue belong to the tab that started it. Separate
processes remain available for hard isolation (and are what profiles use).

### Guard strictness

Block-by-default with an explicit plain-English approval for escaping the
project root. Trust-first fits less-technical users; power users stay
unblocked.

### SOUL.md layering

Profile SOUL.md is the identity in the system prompt; a project may layer
its own short charter (PROJECT.md) underneath. pi's AGENTS.md loading
continues unchanged.

### Sequencing (the spine)

Cost ledger → spend cap → memory tool → profiles → projects + root guard →
skin (sidebar/tabs, onboarding, preview pane). **August scope:** spine +
profiles + projects with the CLI/TUI guard; the skin is the assembly layer
that follows.

## Alternatives considered

- **Projects without profiles (flat).** Rejected: the owner asked for
  Hermes-style profiles; the two-level split maps identity to isolation
  (process) and workspace to scope (tool), and profiles map to engagements
  (the money thesis: client = profile, deliverable = project, budget =
  project cap).
- **Prompt-only drift prevention.** Rejected: instructions do not stop
  memory contamination or wrong-file edits; enforcement must live at the
  data and tool layers.
- **Process-per-project only (no tabs).** Rejected as the default: the
  desktop-app feel needs one window; processes remain for hard isolation.
- **Block-always guard.** Rejected: trust-first fits the target user;
  escape approval keeps power users unblocked.

## Consequences

- The port queue expands: **#7 memory tool** (pi has none — the tool
  itself, not just eviction), **#8 profiles**, **#9 projects + root guard**;
  the skin is the assembly layer after the spine.
- Each port is a tracker issue, red-first, on the baseline.
- Vocabulary: CONTEXT.md gains Profile, Project, Root guard, Drift ladder.
