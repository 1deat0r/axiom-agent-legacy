# ADR-0030 — CLI command menu and shell completion, single-registry

- Status: accepted
- Date: 2026-08-12
- Related: ADR-0014 (profiles, projects), ADR-0015 (prime-agent baseline)

## Context

Axiom's gateway already exposes `/profiles` and `/projects` (ADR-0014). On the
CLI side the picture was uneven: `profile` was a real command but sat in a
parallel dispatch gate alongside `main.ts`'s registry path, so it never
appeared in `axiom help` or the `COMMAND_SPECS` menu; `projects` had no CLI
command at all; and the CLI shipped no tab-completion of any kind, for any
command. The menu (`axiom help`), the set of recognized subcommands
(`PUBLIC_COMMAND_NAMES`, derived from `COMMAND_SPECS`), and reality were three
different sources of truth about what the CLI can do.

## Decision

One registry, three surfaces, all derived from `COMMAND_SPECS`:

- **Menu**: `profile` (with `profile create|list` children) joins
  `COMMAND_SPECS`, so it appears in `axiom help` and `axiom help profile`.
  The parallel `public-command.ts` and `main.ts` gates stay as the *executors*;
  the registry becomes the *roster* that help and routing reference.
- **`axiom projects`**: a CLI sibling of the gateway `/projects` command
  (`cli/projects-command.ts`), operating on the active profile's projects
  root (`AXIOM_HOME`/projects), mirroring ADR-0014's profile-home model. It
  is routed by the same pass-through gate pattern as `profile`.
- **Shell completion**: `axiom completion bash|zsh` prints a completion
  function; the function shells back into `axiom completion candidates -- <words…>`
  on each `<Tab>`, and candidate computation (`cli/completion-command.ts`,
  pure + unit-tested) reads `COMMAND_SPECS` plus the active profile's project
  names. So the completion list can never drift from the roster.

## Consequences

The CLI now has one source of truth for what commands exist, mirrored across
menu, help, routing, and autocomplete. All are gateway-local-free: the three
new public names route to their dedicated CLI gates and never reach the model
as prompts (ADR-0001's spirit — commands stay local). Adding a future command
is a one-line registry entry plus its gate; menu, help, and completion all
follow. Shell completion is sourced at runtime (dynamic), so it stays in sync
without regeneration. The deeper ADR-0014 project-binding (project = root-dir
anchor with own memory/ledger/sandbox) is out of scope here; this covers only
the CLI roster and the directory-management surface already present in the
gateway's `/projects`.
