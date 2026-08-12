# Handoff — terminal `profile switch` (gateway /profiles parity)

## What
Closed the last command-surface gap between the gateway chat and the
terminal CLI over profiles (ADR-0014). The gateway `/profiles` offered
create|switch|list; the terminal `profile` only had create|list. Added
`profile switch <name>` so non-messaging users get identical coverage.

## Where
- `packages/coding-agent/src/cli/profile-command.ts` — new `switch` branch in
  `handleProfileCommand`, plus a `baseHome()` helper so a profile command run
  from *inside* a profile still lists/validates against the base
  `<base>/profiles` root (mirrors the gateway reading base AXIOM_HOME).
- `packages/coding-agent/src/cli/command-registry.ts` — added
  `["profile","switch"]` to `COMMAND_SPECS` (the single source of truth that
  feeds both `--help` and the shell completion popup, so it cannot drift).

## Behaviour
- Unknown name → lists existing profiles (or "No profiles yet").
- Already running as the requested profile → "already running as '<name>'".
- Otherwise → "validated profile '<name>' — run 'axiom --profile <name>' to
  operate as it" (a terminal run is a flag, not a persistent boot).

## Verified how
- Red-first: new `test/profile-command.test.ts` (6 cases) + updated
  `completion-command.test.ts` (`profile` → create|list|switch) and
  `public-command.test.ts` (help usage line). 19/19 focused tests green.
- Live binary: `axiom --help` lists `profile`/`projects`; `axiom completion
  candidates -- profile ""` yields `create list switch`; live run against a
  scratch AXIOM_HOME both validates a real profile and rejects an unknown one.
- `npx biome check .` clean (1009 files), `tsgo --noEmit` clean.
- Full `./test.sh`: only the documented sandbox known-fails (daemon-serialized
  refine, 4603x4, 4685x9); `kernel-attach-image-skill` flaked once under
  parallel load but passes 9/9 standalone (7s) — not a regression.
- Pre-commit hook (biome + tsgo + installer render + browser smoke) all passed.
- Committed bd0785444, pushed to origin/main (main == origin/main).

## Not done / follow-ups
- New ADR intentionally skipped: this is parity *within* existing
  ADR-0014's profile surface, not a new capability or decision.
- `profile list` from inside a `--profile` session still reads the nested
  home's `profiles/` dir (pre-existing). `switch` was made base-correct; if
  desired, `list` could adopt `baseHome()` too — small, optional cleanup.

## Addendum — interactive terminal `/profiles` and `/projects` (2026-08-12)

Key correction: "terminal menu" for a `/`-prefixed command means the
INTERACTIVE terminal agent's slash menu (BUILTIN_SLASH_COMMANDS), not the
shell `axiom --help` command list. `profile`/`projects` shell subcommands
already existed, but typing `/pro` inside the interactive agent matched
nothing because `/profiles`/`/projects` were gateway-only.

Registered both as canonical builtin slash commands
(`src/core/slash-commands.ts`) so they appear in the `/pro` autocomplete
(the createBaseAutocompleteProvider maps every builtin command), are
recognized (never routed to the model), and dispatch locally via
`handleProfilesSlashCommand`/`handleProjectsSlashCommand`
(`src/modes/interactive/interactive-mode.ts`), which reuse the pure CLI logic
(`handleProfileCommand`/`handleProjectsCommand`) with stdout captured into
the chat. Red-first slash-commands tests (registration + arg resolution),
20/20. Commit 8d697a0c8. Verified biome + tsgo clean, bundle carries the
commands, full ./test.sh only documented sandbox known-fails.

Three terminal surfaces now agree: `axiom profile|projects` (shell), and
`/profiles`/`/projects` (interactive terminal chat + messenger gateway).
