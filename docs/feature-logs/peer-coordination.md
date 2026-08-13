# Feature log — agent peer coordination (ADR-0038, issue #20)

Built on feat/peer-coordination, cut from main 00da2f3f0, isolated worktree
.worktrees/peers. Red first: 28 tests across six files, then the
implementation.

Modules: core/peers (types, instance-id, scope, presence, board, peers
facade, format), extensions/peers (four model tools + session/turn hooks),
cli/peers-command. Wired into builtInExtensions and the main.ts dispatch.

Honest limits, recorded: same-host same-user scope; two runs of one profile
share an inbox cursor; a hard git-mutation guard and fs.watch mid-run
wakeups are deliberate follow-ups (the guard belongs on the security-fence
seam, ADR-0028); presence liveness uses pid probe plus heartbeat age, not
flock, so a pid-recycled stale record is only caught by heartbeat age.

Verification: 28/28 feature tests, biome clean, tsgo clean, full ./test.sh
regression run with only the documented sandbox known-fails.

## Follow-up: human-first terminal rendering (feat/peers-cli-output)

The first CLI output dumped raw JSON-ish lines (ISO timestamps, "model
unknown", run IDs) — technically correct, hard to scan. Rebuilt to terminal
standards: aligned columns with status glyphs (● active, ○ stale), relative
timestamps ("2m ago"), ellipsized long values sized to the terminal width,
ANSI color respecting TTY/NO_COLOR/FORCE_COLOR, a legend footer with the
unread count, empty states with next actions, --json machine mode, and the
global command-registry help enriched with the flags. Model-facing plain
text renderers untouched. New module core/peers/render.ts. Red-first: 12
render tests + rewritten CLI tests; full ./test.sh floor verified on the
branch (4928 passed, 14 failed = documented sandbox known-fails only).
