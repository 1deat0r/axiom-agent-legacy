# ADR-0076: Kernel host-bridge stall under concurrent boots — root cause is worker starvation, not a bridge defect

**Status:** proposed (owner confirmation needed — contradicts issue #52's premise that the kernel-heavy tag is interim)
**Date:** 2026-08-15
**Investigated by:** agent session (issue #52)
**Evidence:** four full-shard reproductions (kernel-heavy included in the default parallel run), per-phase boot traces, host- and kernel-side comm traces

## Context

Issue #52 charged the kernel host bridge with stalling host-request cells when
two or more provisioners boot concurrently, and set acceptance criteria that
assume a product defect: a deterministic red repro, a named comm or venv race,
a product-code fix, and the kernel-heavy suites green in the default sharded
run with the tag dropped.

Four full-shard runs (kernel-heavy re-included via `--tagsFilter="!process-stress"`)
each reproduced 1-2 suite timeouts, in different suites every run (goal-skill,
attach-image, kernel-gc, rlm-heartbeat, acp-kernel-features). The evidence
does not support the bridge-defect hypothesis.

## Findings (what the traces prove)

1. **No lost host-bridge messages.** Every host reply send reached the kernel's
   control channel (instrumented `comm_msg` receipts, `found=True` for the
   registered comm, 100% across runs). Every host-side session ended idle.
   The 2-provisioner concurrent repro (the previous session's
   `52-concurrent-kernel-boot-stall.test.ts`) passes, as do 18 concurrent
   suite-boots under synthetic CPU load.
2. **The stalls are worker-process descheduling.** Phase traces show 60-178s
   wall-clock gaps between "ports resolved" and "probeReady done" in the
   failing tests' boots — with probeReady *succeeding* afterward and the
   following executes completing in 10-20ms. probeReady carries a 5s timeout,
   so a kernel-side stall would have failed the probe; only a descheduled
   worker event loop (timer + queued reply both ready at resume, reply wins
   the race) matches the signature. The default sharded run oversubscribes the
   machine with ~400 worker processes plus their kernel children.
3. **Aggravating factor (real, secondary): per-boot re-verification.** Each
   boot that misses the per-process memo spawns python twice
   (`import ipykernel`, then the runtime harness check) before the lock.
   Under load these spawns are seconds of CPU each. Merging them into one
   spawn is a safe, contract-preserving reduction; skipping the runtime check
   on a current marker is NOT — six tests pin the corruption-detection
   contract (broken venv, stale installed rlm with a current marker).
4. **Aggravating factor (real, secondary): the shared-venv bootstrap lock.**
   One worker held it ~178s under load (a real provisioning/sync cycle);
   waiters poll at 100ms behind it. Correct serialization, slow under load.
5. **Hygiene finding:** five orphaned axiom forkserver daemons (plus /tmp
   forkserver dirs) from earlier sessions linger; a forkserver readiness
   timeout (30s) plus the direct-spawn 5s port window can cascade a boot
   failure after the shard runs.

## Decision (proposed)

1. The kernel host bridge is exonerated. No comm race or lost-message fix is
   warranted by the evidence.
2. The `kernel-heavy` tag is the standing load-management mechanism, not
   interim containment: suites that boot real kernels do not belong in the
   ~400-worker default sharded run. Issue #52's "drop the tag" acceptance is
   revised to "keep the tag, documented here".
3. Product hardening (optional, follow-up issues): merge the two readiness
   python spawns into one; forkserver orphan cleanup on dispose.

## Consequences

- `52-concurrent-kernel-boot-stall.test.ts` stays as the bridge-soundness
  regression (green under concurrent boots).
- Issue #52 closes with this analysis once the owner confirms the tag
  decision; the close audit comment links this ADR and the branch.
