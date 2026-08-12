# Handoff — CLI command menu, `axiom projects`, and shell completion

## What was done

Three gaps closed (ADR-0030), all because the CLI had no single roster:

1. **`profile` is now in the menu.** It was a working command that bypassed
   `COMMAND_SPECS`; it now has a registry entry (+ `profile create|list`
   children), so `axiom help` and `axiom help profile` list it, and
   `PUBLIC_COMMAND_NAMES` admits it. Its executor is unchanged; a
   `public-command.ts` pass-through case routes it to the existing
   `handleProfileCommand` gate.
2. **New `axiom projects` CLI command** (`cli/projects-command.ts`), the CLI
   sibling of the gateway `/projects`: list / `add <name>` / `rm <name>` on
   the active profile's projects root (`AXIOM_HOME`/projects, mirroring
   ADR-0014's profile-home model). Wired as its own gate in `main.ts`.
3. **Shell completion** (`cli/completion-command.ts`): `axiom completion
   bash|zsh` prints a completion function that shells back into `axiom
   completion candidates -- <words…>` each `<Tab>`; candidates come from
   `COMMAND_SPECS` (all levels) plus existing project names for
   `projects rm`. Registered + routed as a public command, never a prompt.

Roster (`COMMAND_SPECS`) is now the one source of truth for menu, help,
routing, and autocomplete.

## How it was verified

- **Unit (all green, red-first)**: `test/projects-command.test.ts` (7),
  `test/completion-command.test.ts` (13), and added routing/help cases in
  `test/public-command.test.ts` (34). Also re-ran `profile.test.ts` (28) and
  `owned-session-worker.test.ts` (4) since `PUBLIC_COMMAND_NAMES` changed —
  the owned-worker classifier still passes every public command through.
- **Toolchain**: `npx biome check` clean on all touched files; `tsgo --noEmit`
  clean.
- **Floor**: full `./test.sh` — 4597 passed / 15 failed. The 15 are ONLY the
  documented sandbox known-fails (4603-worker-recovery 4, 4685-daemon-client-
  modes 9, daemon-serialized-refine 1) plus one unrelated real-kernel load
  flake (4428 ipython bash-cell timeout; passes standalone 5/5). No
  regressions from this change.
- **Live (manual, sandbox-ok)**: `axiom completion bash` / `completion zsh`
  emit valid completion functions; `axiom help` now lists profile, projects,
  completion.

## Follow-ups (out of scope, honest)

- Deeper ADR-0014 project binding (project as a root-dir anchor owning its
  own memory/ledger/sandbox) — this covers only the roster + directory
  surface already present in gateway `/projects`.
- `zsh` completion is thin (subcommand names + project values); richer flag /
  option completion and a `--profile` candidate source could come later.
- An install helper (`eval "$(axiom completion bash)"`) is CLI-printable but
  not auto-sourced by installers.
