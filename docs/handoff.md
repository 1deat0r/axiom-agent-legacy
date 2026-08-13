# Handoff — 2026-08-13 (latency plan P1-P4 complete + profile editing + probe tooling)

## Done
1. **P1-P4 latency plan (ADRs 0042-0045)** — parallel tool-call guidance,
   segment planner, non-blocking delegate, tool-turn thinking override.
2. **Profile file editing (ADR-0046)** — `profile edit <name> [--settings]`
   CLI + `/profiles edit <name>` slash command + second-level action menu
   in the /profiles TUI menu (Switch / Edit SOUL.md / Edit settings.json).
   TUI editing stops the interface, runs $EDITOR blocking, restores it.
3. **Latency probe tooling** — `tools/latency-probe/analyze.mjs` +
   `tools/latency-probe/RUN.md` (A/B turns-per-task measurement; needs a
   profile with API keys, not available in this sandbox).
4. **RpcClient default cliPath fix** (2220c1727).

## How it was verified
- Red-first tests: profile-command 14/14, profile-edit-flow 6/6,
  completion+public-command snapshots 50/50, plus the full P1-P4 suites.
- PTY probe (tmux, scratch AXIOM_HOME, fake $EDITOR): /profiles -> alpha ->
  Edit SOUL.md -> editor ran (marker file) -> TUI restored with the
  confirmation line; `axiom profile edit beta` verified via CLI too.
- Full ./test.sh: 4978 passed / 14 failed = documented sandbox known-fails
  (4603x4, 4685x9+2 EXDEV variance, daemon-serialized-refine x1); all
  other parallel-shard flakes pass standalone. biome + tsgo clean; dist
  rebuilt.

## Notes
- The live gateway still runs its old in-memory module graph; fresh
  completion children pick up the rebuilt bundle next message. Remove the
  gitignored repo-root dist/cli.js symlink after the next gateway restart.
- To enable P4: add "toolTurnThinkingLevel": "low" to the profile's
  settings.json, then run the latency probe before/after to quantify.
- /profiles edit currently edits SOUL.md and settings.json; sessions or
  key files are deliberately not editable from the menu.
