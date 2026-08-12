# Handoff — axiom restart onto prime-agent v0.7.2

**Date:** 2026-08-12. **Run type:** autonomous (Feature Implementation Loop v2).
**Model:** the coding agent that developed this repo.

## What was done

The axiom-agent repo was completely restarted on **prime-agent v0.7.2** as the
new baseline (ADR-0015), replacing the pi v0.84.1 fork (ADR-0013).

1. **Repo mechanics** — new remote `upstream` -> PrimeIntellect-ai/prime-agent
   (old pi remote kept as `upstream-pi`); branch `baseline/prime-v0.7.2` at the
   v0.7.2 tag (83a0f9f95); pi fork renamed `archive/pi-v0.84.1` (kept, not
   deleted).
2. **Floor** — `npm run check` (biome + tsgo + installer + browser-smoke) green
   on the fork after install; coding-agent suite green modulo the sandbox-only
   daemon-suite EXDEV (below).
3. **Port of the four axiom capabilities** — `axiom-ledger` (cost ledger +
   spend cap), `axiom-memory`, `axiom-profile` re-ported onto the v0.7.2
   extension seam; `--profile` CLI boot seam + `axiom` root bin.
4. **Tests** — 6 extension test files (128 tests) + 2 acceptance files
   (8 persona journeys) green, including two new regression tests pinning the
   restart's risks (boot pre-scan + env-var name; ledger x real v0.7.2 session
   format).
5. **Docs/rituals** — ADR-0015, CONTEXT.md, SOUL.md, AGENTS.md, docs/ports.md,
   this handoff, test.sh env scrub.

## What was verified, and how

- **Type/build (verified via `tsgo --noEmit`, `npm run check`, `npm run
  build`)** — the ported sources compile against v0.7.2 types; `axiom
  --version` -> 0.7.2; `axiom --help` lists `--profile`.
- **Capability behavior (verified via unit tests, fake-pi harness)** — 128
  extension tests green; ledger/cap/memory/profile behavior is asserted, not
  tautological (buckets sum, overrides reprice with notes, cap blocks at the
  threshold, eviction fires, profile homes isolate).
- **End-user behavior (verified via unit-level persona acceptance, real
  defaults)** — 8 journeys green (Dana/Mira/Nadia/Sam/Lena etc.).
- **Restart risks (verified via two new unit tests)** — `profile-boot.test.ts`
  pins the `PRIME_AGENT_CODING_AGENT_DIR` name (a stale `PI_CODING_AGENT_DIR`
  would silently unisolate profiles) and the `--profile` pre-scan;
  `ledger-session-format.test.ts` drives a real v0.7.2-format session file
  through the ledger so format drift cannot silently under-count spend.

## Known-fails (honest, with reason)

- **4603-worker-recovery, 4685-daemon-client-modes (13 tests)** — deterministic
  EXDEV (`Invalid cross-device link`) hard-linking `/usr/bin/node` into the
  test dir: this sandbox mounts writable dirs on btrfs subvolumes none of which
  share a subvolume with `/usr/bin/node`, so hard links are forbidden. These
  pass in upstream CI on normal filesystems. Sandbox-environment, not a
  baseline defect.
- **4600/4606/daemon-supervisor-process** — pass in isolation; flicker one test
  under full-suite parallel load (interference). Environmental.
- **The baseline daemon-client path is disabled** while the always-on axiom
  extensions load (they are process-local factories). Documented fork
  behavior (ADR-0015), same tradeoff the pi fork made.

## Owner-judgement items

- GitHub default branch is still `master` until pushed; this run sets
  `baseline/prime-v0.7.2` as the restart line and moves the default branch.
- Data cutover (ADR-0015): `~/.axiom` ledger config + memory carry over;
  lifetime spend resets at zero. If the owner prefers a fresh axiom home
  instead, that is a one-line `AXIOM_HOME` default change, not a port change.

## Follow-ups (non-blocking, from external implementation review — 100/100)

- **Live `agent_end` dispatch confirm:** the ledger/cap handler registration and
  the event shapes are pinned by unit tests, but a live interactive boot (one
  `/cost`, one capped run) would close the last integration gap. Blocked in this
  sandbox by no TTY / no provider key; run `axiom`, then `/cost` to confirm.
- **Lifetime `/cost` is an O(n) session-file scan**; fine for interactive use,
  add a cache only if the ledger lands on an autonomous path.

---

# Handoff addendum — Signal gateway + project-manager assistant (ADR-0016)

**Date:** 2026-08-12. **Loop:** Feature Implementation Loop v2 (second feature).

## What was done

Implemented axiom's first living surface on the prime-agent v0.7.2 baseline:
`axiom gateway` — the agent, riding a profile's SOUL.md, reachable over Signal
(signal-cli), replying as a project manager. Modules: gateway router
(channel->session index, command vs agent, per-channel serialization, sender
allowlist), Signal transport (signal-cli send/receive, faked in tests),
project-manager commands (/help, /profiles, /projects, /soul), and a completion
adapter that reuses the headless print-mode seam (`axiom -p ... --profile
<name> --session-id <id>`).

## What was verified, and how

- Gateway behavior (unit tests, 27 new): channel index get/set/persist/reload;
  message normalization + isCommand; Signal transport send argv + receive
  delivery + skip-none; router (allowlisted sender -> completion; command ->
  local effect, model never called; unknown sender denied before model;
  per-channel serialization max-in-flight=1; completion-failure error reply);
  PM commands (profiles/projects/soul real-dir effects); completion argv
  contract (exact `-p --profile --session-id` invocation captured).
- Cross-checked: `npm run check` + `tsgo` + `npm run build` green; `axiom
  gateway --help` prints usage. Full relevant suite 163 tests green (128
  extensions + 8 acceptance + 27 gateway).

## Scoped deviations from the approved plan (recorded honestly)

- **Step 6 "real headless seam via faux provider"** was scoped down. Driving
  the real print-mode seam in-process would require duplicating main()'s heavy
  runtime bootstrap (resource loader, model registry, session manager) — the
  blast radius the plan review explicitly wanted to avoid. Instead: the
  completion argv test proves the real CLI is invoked under `--profile`
  (the wiring that activates the SOUL.md ride), and the SOUL.md-append behavior
  itself is already pinned by the ported axiom-profile extension suite. The
  full live print-mode run needs a live provider and is the operator follow-up.

## Operator follow-ups (live/operator-gated)

- Link a signal-cli account (device linking) and add the owner's number to
  `<AXIOM_HOME>/gateway/config.json` senders.
- Point the completion runner at a working provider, then run `axiom gateway
  --profile <name>`; send a message to confirm the live reply and the live
  signal-cli send.
