# Handoff — 2026-08-15 (ownership lattice: ADR-0081 decided, red fence on branch)

## Done

1. **ADR-0081 written and committed** (issue #55's reservation): the
   ownership lattice — pin / protected / curator layers over the paths axiom
   owns, `classifyPath` (most-specific boundary-safe prefix, tie → stricter
   layer, unmapped → outside), `admitWrite` (pin absolute for every actor;
   learning actor curator-only via `LEARNING_ACTOR_TOOLSET`; outside fails
   closed for both actors), `defaultLatticeConfig` built from the same
   constants the loaders use, `installCapturedSkill` (curator source,
   curator target admits + real-loader verify; protected target returns the
   manual `cp -r`; pin/outside hard refusals), and `<AXIOM_HOME>/curator-skills`
   as the live loop-owned skills dir loaded via the `resources_discover` seam.
2. **Red-first fence** `packages/coding-agent/test/ownership-lattice.test.ts`:
   29 tests (13 classify, 1 toolset, 7 admitWrite, 8 install) against the
   module's type-contract stub. Red for the right reason — every function
   throws "not implemented" — committed to `feat/ownership-lattice` and
   pushed (`10efd23fc`). tsgo/biome green on the branch (the stub pins the
   contract so the hook stays honest while the tests are red, per the
   execution rules).
3. **Baseline floor, detached, on main** (log: `/tmp/floor-lattice-baseline.log`):
   agent-core 4, ai 49+23 skipped, coding-agent main 429 files (5809 passed +
   116 skipped), tui node:test, kernel 12 files, process-stress 2 files —
   all green; auth.json restored. This is the floor that gates anything
   reaching main from the lattice work.
4. **Stale-branch housekeeping:** `feat/learn-command` was already gone;
   `feat/autonomy-direction-adr-0076` remains the owner's call (tip == main,
   per the prior handoff).

## How it was verified

- The fence was shown red three ways: import failure before the stub existed,
  29/29 failed against the throwing stub, and the pre-commit hook's tsgo
  catch proved the gate is honest (it blocked the commit until the contract
  stub existed).
- `npx biome check` clean on both touched files (4 pre-existing infos in
  other files, none touched).
- The floor ran on the exact main tree, detached, scrubbed env, and passed
  every workspace — the "before anything reaches main" gate for this thread.

## Notes

- The stub in `src/core/ownership-lattice/index.ts` is a deliberate
  type-contract pin, not an implementation; it must not survive the
  implementation commit (the thrower goes, the bodies land).
- The red test is on a WIP branch only — main is untouched and floor-green.
- CONTEXT.md's "Ownership lattice" term ships with the implementation, per
  the ADR.

## Next

1. Implement the lattice core against the fence (classify → admit → install),
   red-to-green, then wire the consumers: `/learn`'s report + install verdict,
   the ADR-0027 hook's curator auto-install, the `resources_discover` emission
   for `curator-skills`, and `admitWrite` checks on the consolidation write
   paths. CONTEXT.md term with the implementation.
2. Owner's calls still open: #52 tag decision + optional spawn-merge
   hardening; delete `feat/autonomy-direction-adr-0076` (tip == main).
3. After the lattice: session recall (#56, ADR-0082), then the rest of the
   ADR-0078 port order.

## Next-session prompt (ready to paste)

> You're in /home/mustbearn/Projects/axiom-agent, branch main, pushed and
> floor-green (log: /tmp/floor-lattice-baseline.log). ADR-0081 (issue #55)
> is decided and the 29-test red fence is on feat/ownership-lattice
> (10efd23fc) against the throwing contract stub in
> packages/coding-agent/src/core/ownership-lattice/index.ts.
> Read SOUL.md, AGENTS.md, docs/handoff.md, ADR-0078, and ADR-0081 first.
>
> Implement the ownership lattice red-to-green: classifyPath (most-specific
> boundary-safe prefix, tie → stricter layer, unmapped → outside),
> admitWrite (pin absolute, learning actor curator-only via
> LEARNING_ACTOR_TOOLSET, outside fails closed), defaultLatticeConfig from
> the loader constants, and installCapturedSkill (curator→curator with the
> real-loader verify; protected gets the manual cp -r; pin/outside hard
> refusals). Then wire the consumers: /learn's install verdict, the ADR-0027
> hook's curator auto-install, the resources_discover emission for
> <AXIOM_HOME>/curator-skills, and admitWrite on the consolidation write
> paths. The stub's thrower dies with the implementation.
>
> Keep the floor/bundling honest: run ./test.sh detached before anything
> reaches main. Issue #55 stays open until the close ritual. Report back
> when the fence is green.
