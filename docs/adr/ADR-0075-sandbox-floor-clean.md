# ADR-0075: The sandbox floor known-fails are fixed at the source, not allowlisted

Status: accepted
Date: 2026-08-15

## Context

Two suites carried documented known-fail status in this sandbox (AGENTS.md):
4603 failed at setup because it hard-links the node binary across a btrfs
subvolume (EXDEV); 4685 failed because the sandbox sets both NO_COLOR and
FORCE_COLOR, so every spawned node child prints a warning into stderr that
the suite's empty-stderr assertions reject. Two kernel host-bridge suites
flaked at the default 30s timeout under the parallel full-floor load. An
allowlist that festers trains nobody; every failure should be a real signal.

## Decision

Fix each failure at its source; delete the allowlist.

1. **4603 (EXDEV):** the test harness falls back to a byte copy of the node
   binary when the hard link fails with EXDEV. Spawning the worker needs an
   executable, not an inode alias; a copy is functionally equivalent.
2. **4685 (stderr pollution):** the suite's spawn helpers pin the child env
   they assert against: NO_COLOR=1, FORCE_COLOR unset. test.sh additionally
   scrubs both vars so the whole floor is color-neutral.
3. **Kernel host-bridge flake:** the three bridge suites that boot real
   kernels get the repo's existing `kernel-heavy` tag (excluded from the
   sharded run, run serialized by `test:kernel`, which test.sh now runs as
   a second phase). The underlying concurrency stall is a real defect and
   is tracked separately (issue #52, ADR-0076) — the tag is interim
   containment, not the fix.
4. **Wall-clock daemon races:** the 4603 suite asserts process lifecycles
   across real respawns and 11s post-shutdown delays; under parallel floor
   load the respawn machinery races those checks. It gets the repo's
   existing `process-stress` tag and runs serialized in the third phase
   (`test:process-stress`), alongside daemon-supervisor-process.
5. **Untagged kernel-booters (merge-time sweep):** the heavier post-#50
   floor exposed three more untagged real-kernel suites (ipython-bootstrap,
   ipython-provisioner, kernel-agent-observe-skill) plus the 4428 bash-cell
   test. All are tagged `kernel-heavy` and added to `test:kernel`. A
   residual daemon race (services reappear within 11s of a clean
   shutdown --force, about 1 in 4 floors) is tracked as issue #53
   (ADR-0077) and is a product-code fix, not a test-timing one.
4. **Host dependency:** the 4603 shutdown regression needs `lsof`; the host
   installed it (4.99.7). AGENTS.md records the requirement.

AGENTS.md's sandbox note now states the floor is the gate: any failure is
real.

## Considered options

- **Keep the allowlist** — rejected: known-fails fester, and a clean floor
  is the merge gate's strongest signal.
- **Skip-on-absent (lsof, rg)** — rejected for the suites: skipping is
  muting by another name; the dependency is a host requirement, documented.
- **Rewrite the suites to avoid node-link and stderr assertions** — rejected:
  the assertions are the point; the fixes keep them and remove the
  environment coupling.

## Consequences

- The full floor (default sharded phase, serialized kernel phase, serialized
  process-stress phase) must now pass with zero failures in this sandbox;
  any failure is investigated, not classified.
- New suites that spawn node children must pin the color env they assert
  against (the 4685 pattern); new kernel-booting suites must carry the
  `kernel-heavy` tag until issue #52 lands.
- The lsof binary is a host requirement for the 4603 shutdown regression.
