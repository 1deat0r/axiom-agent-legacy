# ADR-0046 — Edit profile files from the CLI, the /profiles command, and the TUI menu

## Status
Accepted (2026-08-13)

## Context
Profiles could be created, listed, and switched, but their identity files
(SOUL.md, settings.json) had to be edited by hand in the filesystem. The
user asked for first-class editing: a command inside axiom-agent and an
edit option inside the /profiles TUI menu.

## Decision
Add profile file editing on three surfaces, all sharing one validated
path:

- `axiom profile edit <name> [--settings]` — opens the profile's SOUL.md
  (default) or settings.json (`--settings`) in `$EDITOR` (falls back to
  `vi`; `resolveEditorCommand` parses commands with arguments like
  "code --wait"). Registered in the command registry + completions.
- `/profiles edit <name> [--settings]` slash command — same flow inside
  the TUI. Because the TUI owns the terminal, the flow stops the TUI
  (raw mode + alt screen, the same transition Ctrl-Z suspend uses), runs
  the editor as a BLOCKING child with inherited stdio, then restarts the
  TUI and re-enters fullscreen.
- `/profiles` menu gains a second-level action menu per profile
  (Switch to profile / Edit SOUL.md / Edit settings.json), mirroring the
  /connectors two-level pattern.

`runProfileEditFlow` (new module
`modes/interactive/components/profile-edit-flow.ts`) holds the injected
deps (list/resolve/editor/ui lifecycle) so the flow is unit-testable
without a terminal.

## Consequences
- Profile identity files are editable without leaving axiom's surfaces.
- Editing in the TUI suspends the interface for the editor's lifetime and
  restores it after; verified end-to-end with a PTY probe (menu -> action
  -> fake $EDITOR -> restored TUI + confirmation line).
- 14 new red-first tests (target/editor resolution, CLI edit paths, flow
  stop/spawn/start ordering + error handling, arg parsing); two command
  snapshots updated. Full ./test.sh: 4978 passed / 14 failed = documented
  known-fails; remaining flakes under parallel shards all pass standalone.
