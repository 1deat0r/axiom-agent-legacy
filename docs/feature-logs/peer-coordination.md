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
