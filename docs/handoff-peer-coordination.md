# Handoff — agent peer coordination (feat/peer-coordination, ADR-0038)

What was done: instance IDs, presence, board messaging, and group chat for
co-anchored axiom-agent instances, plus an `axiom peers` CLI. See
docs/feature-logs/peer-coordination.md and docs/adr/ADR-0038-agent-peer-coordination.md.

How it was verified: red-first (6 files, 28 tests) then green; biome and
tsgo clean; full ./test.sh ran with only the documented sandbox known-fails.
The wired files (extensions/index.ts, main.ts) carry only the two-line
additions; no other file changed. Not merged to main; live gateway untouched.

Follow-ups filed: none beyond the ADR's own (git-mutation guard on the fence
seam, fs.watch wakeups, cross-host).
