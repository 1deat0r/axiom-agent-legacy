# Handoff — 2026-08-15 (memory consolidation hooks session_shutdown)

## Done

1. **Moved the consolidation hook from `agent_end` to
   `session_shutdown` (reason `quit` only).** In resident sessions
   (interactive TUI, daemon workers) `agent_end` fires after every
   prompt, so a silent-by-default consolidation there would add a model
   call to every turn — against the cheap-per-turn posture ADR-0076
   sets. `quit` is emitted by every mode's dispose path (one-shot
   process exit and daemon session close both await shutdown handlers),
   while `new`/`resume`/`fork` are session switches and `reload` is not
   an end. Proposal messages now come from
   `sessionManager.getEntries()` instead of the `agent_end` payload.
2. **Tests pin the gate.** Three new tests in
   `packages/coding-agent/test/extensions/memory-consolidation.test.ts`:
   `agent_end` never consolidates, non-quit shutdown reasons
   (`reload`/`new`/`resume`/`fork`) skip, and the proposal request is
   built from finished-session entries. The `buildRequest` mock is now
   typed with `fromAny<ConsolidationRequest, unknown>`.
3. **Docs.** CONTEXT.md "Memory consolidation" term rewritten
   (silent-by-default since ADR-0076, `session_shutdown` + `quit`
   rationale, opt-out flags); ADR-0076 consequence line appended
   (hook moved from `agent_end` to `session_shutdown`, amended
   2026-08-15 before merge, keeping cheap-per-turn).
4. **Committed and pushed** to `feat/autonomy-direction-adr-0076`:
   `1850f824c` (the hook change + docs) and `206ffd757`
   (`chore(ai): regenerate model registry` — pre-existing generated
   dirt from the model catalog sync, committed separately).

## How it was verified

- `npx biome check .`: exit 0. The 4 remaining infos are pre-existing
  (telegram-transport ×2, delegate-command, cost-command) — none in
  touched files.
- `npx tsgo --noEmit`: exit 0. The run caught one type error in the new
  test (mock returning `unknown`), fixed before the floor.
- Targeted `memory-consolidation.test.ts` suite: green.
- **Full `./test.sh` floor: GREEN, all five phases** (log:
  `/tmp/floor-autonomy.log`; the script's exit trap restored auth.json,
  so it ran to completion):
  - `agent`: 4 files passed.
  - `ai`: 49 passed + 23 skipped.
  - `coding-agent` main: 427 passed + 15 skipped.
  - kernel: 12 files, 60 passed + 27 skipped.
  - process-stress: 2 files, 12 passed + 8 skipped.
- **daemon-supervisor-process flake: not reproducible.** 8/8 passed
  twice in isolation and 8/8 again inside the full floor. The earlier
  flake has not recurred; the suite is stable in isolation. (Method for
  everything: mocked model for the extension, real kernel bridge for
  kernel skills, real daemon process stress for the supervisor suites —
  never blurred.)

## Notes

- **Operational hazard (correlation, causation unproven):** the live
  daemon hosting this agent session died silently during the floor's
  process-stress phase. Last session activity was 02:35:06Z, inside the
  window of the 4603 "shutdown --force removes hidden supervisors and
  workers through the public CLI" test (~02:34:47–02:35:31Z). The
  daemon log (`daemon.sock.1b1faf65.log`) ends with no shutdown line.
  The floor itself survived as an orphaned child and completed green.
  Worth checking whether that test can reach the real
  `/tmp/axiom-1000/daemon.sock`. test.sh's auth.json move at start is
  exonerated — the session kept working ~4.5 min after it.
- Pre-existing untracked `docs/hermes-improvements.html` was left alone
  (removed from main during gateway-branch cleanup; not part of this
  change).
- `origin` now redirects to `github.com/1deat0r/axiom-agent`.
