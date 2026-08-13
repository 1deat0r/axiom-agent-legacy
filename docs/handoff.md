# Handoff — 2026-08-14 (profile edit: honest editor runs + real editor fallback)

## Done

1. **Profile edit false success fixed.** The /profiles menu printed
   "edited" when no editor ran. Root cause: a null exit status from
   `spawnSync` means the editor did not run (missing binary or signal),
   but the flow treated it as success. `vi` is not installed here, so the
   menu never opened an editor.
2. **One shared editor-run path.** `runEditorSync` and
   `formatEditorOutcome` in `cli/profile-command.ts` classify each run:
   spawn failure, signal, non-zero exit, and zero exit. The CLI and the
   TUI flow use the same functions. No divergent copies.
3. **Real editor fallback.** When `EDITOR`/`VISUAL` are unset, the editor
   resolves to the Debian alternatives editor when usable, then the first
   available of `vi`/`vim`/`nano` on PATH (`vi` stays the last resort).
   On this box that resolves to `/usr/bin/vim`.
4. **Menu error net.** The /profiles action menu catches flow errors and
   prints them. A failure can no longer disappear into an unhandled
   promise.

## How it was verified

- Red-first unit tests: `profile-command.test.ts` (27) and
  `profile-edit-flow.test.ts` (8). 14 new tests cover spawn failure,
  signal, exit-status classification, editor fallback order, and CLI/TUI
  output lines.
- PTY probes (tmux, scratch `AXIOM_HOME`, real binary):
  - no `EDITOR` set: /profiles -> alpha -> Edit SOUL.md opened a real
    vim with the SOUL.md content; `:q!` restored the TUI with the
    confirmation line. Edit settings.json verified the same way.
  - `EDITOR=definitely-not-an-editor`: the menu printed the
    "could not start editor" line with an EDITOR hint; the TUI stayed
    alive.
- Full `./test.sh`: 4998 passed / 17 failed. 14 are the documented
  sandbox known-fails (4603 x4, 4685 x9, daemon-serialized-refine x1).
  The other 3 pass standalone (kernel-agent-message 7/7,
  4600-supervisor-singleton 15/15, agent-session-recursion 96/96 with
  RLM env scrubbed) = parallel-shard flakes.
- `npx biome check .` clean (1082 files); `tsgo --noEmit` clean; dist
  rebuilt.

## Notes

- ADR-0046 gained an Amendment section for this fix.
- If a box has no `vi`/`vim`/`nano` and no alternatives editor, the menu
  now reports the missing editor instead of claiming success. Set
  `EDITOR` to fix it.
- The untracked `docs/hermes-improvements.html` in the working tree is
  not part of this change; it was left alone.
