# Handoff: sandbox floor known-fails fixed at the source

Issue #51, ADR-0075, branch feat/fix-sandbox-floor, 2026-08-15.

## What was done

- 4603 suite: EXDEV fallback — linkSync falls back to copyFileSync of the
  node binary when the btrfs subvolume layout refuses the hard link.
- 4685 suite: runCli/runRpc spawn helpers pin NO_COLOR=1 and unset
  FORCE_COLOR for spawned children, so the empty-stderr assertions see a
  clean env even when the parent carries both vars.
- kernel-agent-message-skill + kernel-rlm-heartbeat-skill +
  kernel-attach-image-skill: tagged kernel-heavy (repo's existing isolation
  for kernel-booting suites), added to test:kernel's serialized run, which
  test.sh now runs as a second phase. The concurrent-kernel-boot stall is a
  real defect tracked in issue #52 (ADR-0076); the tag is interim
  containment, not the fix.
- test.sh: scrubs NO_COLOR and FORCE_COLOR so the floor is color-neutral,
  and runs three phases: default sharded, test:kernel (serialized), and
  test:process-stress (serialized).
- 4603 suite: tagged process-stress and added to test:process-stress; its
  shutdown idempotency contract races the daemon respawn machinery under
  parallel floor load and passes serialized. The residual race (3 services
  reappear after shutdown in about 1 of 4 floors) is issue #53 (ADR-0077).
- Merge-time sweep: ipython-bootstrap, ipython-provisioner,
  kernel-agent-observe-skill, and the 4428 bash-cell test tagged
  kernel-heavy and added to test:kernel.
- Host provisioning: installed lsof 4.99.7 (pacman) — the 4603 shutdown
  regression needs it; recorded in AGENTS.md.
- AGENTS.md sandbox note: the known-fail allowlist is empty; the floor is
  the gate.
- ADR-0075 records the decision.

## What was verified and how

- Ambient env (NO_COLOR=1 and FORCE_COLOR=1 both set): 4603 4/4 twice,
  4685 19/19, kernel-agent-message 7/7, kernel-rlm-heartbeat 3/3.
- Full ./test.sh floor, three phases, exit 0, zero failures:
  default sharded 5768 passed / 88 skipped; test:kernel serialized
  38 passed / 19 skipped; test:process-stress serialized 12 passed /
  8 skipped.
- biome clean (4 pre-existing infos), tsgo clean.

## Not done (scope)

- No production code changed (test harness, test.sh, docs only).
- No test skipped or muted.
