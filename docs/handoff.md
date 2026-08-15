# Handoff — 2026-08-16 (issue #61 closed: forkserver orphan cleanup)

## #61 — forkserver orphans linger after kernel disposal (ADR-0076 finding 5) — CLOSED

- **Root cause.** The forkserver daemon (`python -c FORK_SERVER_SCRIPT`, a child
  of the Node host) cleaned up nothing on host death. On an unclean host death
  (SIGKILL/crash) the daemon itself exited via control-socket EOF, but its
  forked kernels (which share the daemon's cmdline, so they masquerade as
  "forkserver daemons") were reparented to the `systemd --user` subreaper and
  kept running, and the `/tmp/axiom-forkserver-*` socket dir was never removed
  (the host's `rmSync` never runs on SIGKILL). Reproduced red-first: SIGKILLing
  a host process mid-serve left its forked kernel orphaned and its socket dir
  behind.
- **Fix.** The daemon now tracks forked-kernel pids (`_children`), and its
  shutdown reaps them (SIGTERM) and unlinks the control socket plus its
  directory. It distinguishes a graceful host dispose from an unclean death by
  receiving the host's pid in argv and polling `getppid()` briefly for the
  reparenting: the control socket closes (host fd cleanup) *before* the kernel
  reparents us in `do_exit`, so `getppid()` is stale at socket-EOF time. When
  the host is still our parent we leave the kernels alone — the host's own
  dispose will kill them, and racing it would drop an in-flight namespace
  snapshot flush. No PDEATHSIG/ctypes needed.
- **Red-first.** The new test failed red pre-fix (orphaned kernel + lingering
  dir), green post-fix (kernel dies, dir removed). The test SIGKILLs the host
  process by pid (the tsx cli re-execs the fixture as a grandchild, so the
  launcher handle is not the host).
- **Tests.** `kernel-fork-server.test.ts` 5/5 (new orphan-cleanup regression +
  existing gating). The 52 concurrent-boot regression — the other default-on
  forkserver consumer — stays green in isolation (~1.6s, 3/3).
- **Verify.** `npx biome check .` clean, `tsgo --noEmit` clean.

## Floor state (two failures, neither from #61)

- **#62 (new, pre-existing): telemetry notice leaks into a spawned daemon RPC
  client's stderr**, breaking the 4685 empty-stderr assertion. The telemetry
  notice (from `a18809e00`) is emitted when the child's fresh temp `agentDir`
  has no `noticeShown` flag; the 4685 suite pins color env (`NO_COLOR=1`) but
  not telemetry. Reproduced in isolation. Filed as issue #62, `needs-triage`.
- **52-concurrent-kernel-boot-stall**: timed out at its documented 120s ceiling
  under the ~400-worker default shard — the ADR-0075 parallel-floor contention.
  Passes in isolation (~1.6s, 3/3). Not a #61 regression.
- kernel-heavy phase: green (60 passed). process-stress phase: green (13
  passed). Both run with the forkserver disabled or not exercised, confirming
  the kernel/daemon layers are intact.

## General state

- main is at `411f5d632` (the fix), pushed to origin; handoff follows.
- `docs/hermes-improvements.html` untracked everywhere — not ours, ignore.
- Floor logs: `/tmp/axiom-61-floor2.log` (default phase), `/tmp/axiom-61-kernel.log`,
  `/tmp/axiom-61-stress.log`.
- Ritual maintained: red-first, one capability, one handoff; close audit links
  the commit and this handoff (ADR not required — sub-detail of ADR-0076
  finding 5, recorded there).
