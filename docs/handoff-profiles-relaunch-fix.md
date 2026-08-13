# Handoff — /profiles menu relaunch EIO crash fix (main 2c2d1eaf4)

What was done: fixed the terminal /profiles and /projects menu switch. The
workspace relaunch used a fire-and-forget spawn + immediate process.exit(0);
the shell then reclaimed the terminal, the relaunched child landed in an
orphaned background process group, and the kernel denies tcsetattr/read on
the controlling tty for orphaned groups — the child crashed with
"Error: setRawMode EIO" (errno -5) in ProcessTerminal.start. The relaunch now
uses a BLOCKING spawnSync (stdio inherit) so the parent holds the terminal's
foreground process group until the child exits, then mirrors the child's
exit code — the same pattern the /update relaunch uses. A profile switch now
also pins AXIOM_HOME to the profile base home (profileBaseHome) instead of
deleting it, so a custom AXIOM_HOME resolves the same base in the child.

New seam: relaunchWorkspace / buildWorkspaceRelaunchEnv /
defaultWorkspaceRelaunchDeps in
packages/coding-agent/src/modes/interactive/components/workspace-selector.ts
(injectable spawnSync/exit deps), wired through
InteractiveMode.switchWorkspace(opts, deps) with drainInput + stop + dispose
+ onShutdown teardown before the spawn.

Verified how (never blurred):
- Diagnosed test-first per the diagnosing-bugs discipline. Minimal repro
  outside the repo proved the mechanism: parent sets raw mode, spawns a
  child with inherited stdio, exits — child's fd 0 is still a tty yet both
  read and setRawMode return EIO (orphaned background pgrp). Variants
  confirmed: keeping the parent alive makes the child succeed; blocking
  spawnSync lets the child set raw mode AND read keys.
- Regression tests red-first (9 tests in test/workspace-relaunch.test.ts
  failed against the old code; the old switchWorkspace really spawned and
  exited the worker), then green after the fix. 23/23 with the existing
  workspace-selector suite.
- PTY probe (tmux, real dist build, scratch AXIOM_HOME): default -> alpha ->
  beta switches all relaunched without the EIO crash; each profile home got
  its own sessions/auth/settings; the menu marked alpha "(current)" after the
  first switch; Esc closed the menu without switching. Process tree showed
  each parent still alive holding the foreground for its child (the blocking
  spawnSync), i.e. no orphaned relaunch.
- Full ./test.sh: 4935 passed, 16 failed = ONLY documented sandbox
  known-fails (4603x4 + 4685x9 EXDEV hard-link, daemon-serialized-refine 1,
  kernel-agent-message / kernel-attach-image flakes that pass standalone
  7/7 and 9/9). biome check . clean (1077 files), tsgo --noEmit clean,
  pre-commit hooks green. Dist rebuilt so the installed CLI has the fix.

Merged to main and pushed (2c2d1eaf4).

Follow-ups worth considering (not blocking):
- Esc-close leaves the submitted slash command echoed in the transcript
  (same for /projects and /connectors) — cosmetic.
- The default profile is implicit and not listed in the menu, so a named
  profile cannot switch back to default from the menu.
- The relaunch-child crash class (orphaned pgrp EIO) is what
  emergencyTerminalExit already guards; any future "spawn a TUI child then
  exit" code must use the blocking spawnSync pattern, not spawn+unref.
