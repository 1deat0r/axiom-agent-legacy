# Handoff — 2026-08-15 (/learn: the public skill-capture front-end, issue #54)

## Done

1. **Housekeeping for the prior session.** kernel-venv rlm/__init__.py
   verified byte-identical to axiom-runtime/src (no restore). No orphaned
   axiom forkserver daemons were alive (exact process inspection; the only
   live forkserver is this session's own .prime one — untouched). 12 stale
   /tmp/axiom-forkserver-* dirs removed. The autonomy-landing session's
   handoff committed to main (`c12615bae`, pushed). Issue #52 got the
   owner-decision comment: does the kernel-heavy tag stay as standing load
   management, and is the optional merged-readiness-spawn hardening wanted
   (both ADR-0076 proposals, still the owner's call).
2. **/learn landed (ADR-0080, issue #54)**, merged to main at `888fd98ce`.
   - New core module `core/skill-capture/learn.ts`: strict arg parsing
     (nothing or `--force`), `buildLearnCapture` (provenance source "learn",
     trigger "/learn", session id), and `runLearnCapture` (evaluate → build →
     persist → verify; discriminated result; nothing written when unforced
     and not flagged).
   - The skill-capture extension registers the `/learn` command (the /cost
     pattern): it traces the current session's branch from the session
     manager (the persisted truth, SOUL.md), stages the skill into
     `<AXIOM_HOME>/captured-skills`, and offers it — installs are the
     ownership lattice's job (#55). The command stays available while the
     ADR-0027 hook is inert, keeping ADR-0078's silent-by-default posture.
   - CONTEXT.md "Skill capture" term names the /learn surface.
3. **Tests, red first.** 12 core + 7 extension-command tests were red before
   the module existed (import failure; command unregistered), now green.
   A 2-test suite fence (agent-session-learn.test.ts) drives /learn through
   a real AgentSession with the faux provider; it caught that the trace
   comes from the persisted branch, and that harness tool calls need a
   no-op tool or the turn ends with an error stopReason (fixed with a
   probe tool + stopReason "toolUse").

## How it was verified

- Red runs captured before implementation: core suite failed on the missing
  module import; the extension suite failed 7/7 command tests on the
  unregistered command.
- All four skill-capture suites green: 62 tests (12 core learn + 12
  extension + 25 capture + 11 evaluate + 2 suite).
- `npx biome check .`: 4 pre-existing infos, none in touched files.
- `npx tsgo --noEmit`: exit 0 — it caught one wrong import (TaskTrace lives
  in evaluate.ts, not types.ts) and, via the pre-commit hook, the wrong
  stopReason value in the suite fixture.
- **Full `./test.sh` floor, detached, on the exact merged tree** (log:
  `/tmp/floor-learn-final.log`): agent 4, ai 49+23 skipped, coding-agent
  main 429 files (5809 passed + 116 skipped — includes both new suites),
  kernel 12 files, process-stress 2 files (13+8 skipped). auth.json
  restored; the live telegram gateway survived the run.
- An earlier detached floor (`/tmp/floor-learn.log`) ran before the suite
  fence landed and was also fully green; the second run is the one that
  counts, on the tree that reached main.

## Notes

- The `unverified` branch of runLearnCapture is defensive (persist ok but
  the loader says missing) and mirrors the existing CLI; it is not
  unit-tested because the generated document always passes the real
  loader. Noted, not hidden.
- The gateway keeps its own command registry; /learn is an interactive
  (TUI/daemon) surface, like /cost and /cap.
- feat/learn-command is merged; delete it once #54 closes.

## Next

1. Ownership lattice (#55, ADR-0081) — pin/protected/curator-managed,
   which governs what the loop may auto-install (incl. /learn captures).
2. Session recall (#56, ADR-0082) after the lattice.
3. Owner's calls, still open: #52 tag decision + optional spawn-merge
   hardening; delete feat/autonomy-direction-adr-0076 (tip == main).
