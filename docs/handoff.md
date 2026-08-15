# Handoff — 2026-08-15 (stopped mid-stream: #53 fix landed, #52 hardening half-done)

## Where this session started

Picked up from the previous handoff (#59 dashboard landed, ADR-0078 port order
complete; #52/#53 open). Owner ruled on the two #52 decisions live in this
session (see below), then #53 was root-caused, red-tested, fixed, and pushed;
#52's merged-spawn hardening was in progress when the session was stopped.

## Owner rulings (this session — record them)

1. **#52 tag decision: KEEP `kernel-heavy` as the standing load-management
   mechanism.** Issue #52's "drop the tag" acceptance is revised; ADR-0076's
   proposed decision 2 is confirmed. The default sharded run oversubscribes
   the machine (~400 workers) and kernel boots are multi-second CPU work.
2. **#52 hardening: DO the merged-spawn hardening now, inside #52**
   (not deferred to a follow-up). Red-first; six tests pin the
   corruption-detection contract in kernel-bootstrap.test.ts.

## #53 — daemon respawn race (branch fix/daemon-respawn-race, PUSHED)

### Root cause (named)

Worker re-admission gates on the registry-file shutdown admission only —
`assertRecoveryAllowed()` checks ownership + the admission file, but NOT the
supervisor's own `shuttingDown` state. The CLI releases the admission at
listener-silence convergence, which happens BEFORE the supervisor process
exits (catalog stop, socket cleanup, lease/ownership release tail). During
that tail a checkpointed or deferred recovery re-passes the gate, spawns a
detached worker, re-persists its descriptor, and the supervisor exits leaving
ghosts that `status --json` reports after a "clean" shutdown. Second window:
`shutdown()` never awaits in-flight `worker.recovery` / `worker.deferredRecovery`
/ `openingWorkers` before snapshotting `this.workers`.

### Fix (in daemon-supervisor.ts)

1. `assertRecoveryAllowed()` now throws `SupervisorRecoveryCancelledError`
   when `this.shuttingDown` — the invariant: a shutting-down supervisor never
   re-admits workers. Closes every checkpoint window (recovery retry loop,
   launchWorker, connectWorker, deferred-resume, startup adoption unaffected).
2. `shutdown()` awaits `Promise.allSettled` of all in-flight
   `worker.recovery`, `worker.deferredRecovery`, and `openingWorkers` values
   before the workers snapshot. `shuttingDown` is set first, so pending work
   either completes (lands in snapshot → stopped) or self-cancels.
3. Two monitor-test harnesses (daemon-supervisor-monitor.test.ts lines ~982
   and ~1050) gained `openingWorkers: new Map()` to match the new fence.

### Tests

- NEW: test/daemon-supervisor-recovery-shutdown.test.ts — two deterministic
  in-process tests. Red confirmed before the fix ("promise resolved
  'undefined' instead of rejecting"; stopWorker called before recovery
  settled), green after.
- Supervisor unit family: 8 files / 127 tests green.
- Process-stress phase (daemon-supervisor-process + 4603): green, 13 passed /
  8 skipped, 174s.
- biome clean (4 pre-existing infos, none in touched files); tsgo --noEmit clean.

### Commits on the branch (pushed to origin)

- 942bb0895 test(daemon): shutdown must fence in-flight worker re-admission (issue #53)
- da6ead0c1 fix(daemon): gate worker re-admission on shuttingDown and await it at shutdown (issue #53)

### REMAINING for #53

- [ ] Re-run the acceptance: 10 consecutive process-stress runs. A background
      loop was started and killed at the stop (run 1 passed at 154s; the
      remainder never completed — do NOT count them).
- [ ] Full floor green (`./test.sh`, three phases).
- [ ] ADR-0077 is DRAFTED at docs/adr/ADR-0077-daemon-shutdown-fences-recovery.md
      (uncommitted at stop — commit it with this handoff).
- [ ] Merge to main, close #53 with the audit comment (merge commit + ADR +
      handoff), per docs/agents/issue-tracker.md.

## #52 — kernel-bridge (worktree /tmp/axiom-worktrees/kernel-bridge,
branch fix/kernel-bridge-stall, PUSHED before this session)

State from the previous session: bridge exonerated (worker descheduling under
the ~400-worker shard), repro test + roundtrip CLI + ADR-0076 (proposed) on
the branch. The owner's rulings above resolve the open decisions.

### REMAINING for #52

- [ ] Flip ADR-0076 to accepted: decision 2 = keep the tag (standing
      mechanism); decision 3 = merged-spawn hardening lands now in this issue.
- [ ] Finish the merged-spawn hardening (in progress at stop):

  * Product (packages/coding-agent/src/core/kernel/bootstrap.ts):
    merge `hasIpykernel` + `hasPrimeAgentRuntime` into ONE python spawn —
    a readiness probe script (sentinel `_AXIOM_KERNEL_READINESS_PROBE_`,
    prints `{"ipykernel":bool,"runtime":bool}`, exit 0; spawn failure /
    nonzero exit / unparsable stdout → undefined → both false). Replace the
    pairs at kernelReady (line ~840), kernelBaseReady (~827), and the
    AXIOM_KERNEL_PYTHON override path (~862-867). Keep the missing-message
    semantics identical ("ipykernel" vs "a current axiom-runtime with
    callable rlm.run, ...").
  * Tests (kernel-bootstrap.test.ts): writeFakePython already updated in the
    worktree (uncommitted) — probe case prints the JSON from importableModules,
    keeps the plain `import X` cases and the legacy `_harness_methods` case,
    and logs every `-c` payload to $FAKE_PYTHON_LOG. The stale-rlm custom fake
    ("rebuilds a warm venv with a stale rlm runtime") also updated. STILL TODO:
    the legacy-harness custom fake ("rejects AXIOM_KERNEL_PYTHON with a legacy
    harness API") still uses the old cases — add the probe case printing
    `{"ipykernel":true,"runtime":false}`.
  * Add the RED test: warm venv + current .bootstrap-version → exactly ONE
    `-c` readiness spawn recorded in $FAKE_PYTHON_LOG, payload contains the
    sentinel. Red pre-fix (two spawns), green post-fix.
  * installFakeUv's generated venv/bin/python: optional but recommended — add
    the probe case (importables ipykernel+rlm+extras → {"ipykernel":true,
    "runtime":true}); nothing probes the rebuilt venv today, but it future-
    proofs the fake.

- [ ] Verify: kernel-bootstrap.test.ts green, then the kernel-heavy phase
      (`npm run test:kernel --workspace packages/coding-agent`), then the
      full floor. The bridge soundness repro (52-concurrent-kernel-boot-stall)
      and the roundtrip CLI stay on the branch either way.
- [ ] Merge to main, close #52 with the audit comment (merge commit + ADR +
      handoff). Revise the issue acceptance to "keep the tag" before closing
      (the ADR says the issue's acceptance is revised).

## General state

- main is at 863f10ed8 ("docs: handoff — #59 dashboard landed...").
- docs/hermes-improvements.html untracked everywhere — not ours, ignore.
- The #52 worktree has UNCOMMITTED test-fake edits at stop (commit as a
  wip-style commit to avoid losing them; the branch already has a wip commit
  precedent).
- Review-gate convention (owner's standing preference): ONE independent
  reviewer per substantive change; FAIL → fix → re-review until PASS.
- Suggested skills: axiom-agent-development (repo ritual, floor commands,
  tracker close protocol). Kernel-heavy runs are slow (real kernel boots);
  the 4603/process-stress phase is wall-clock sensitive — run them serialized
  per test.sh.
