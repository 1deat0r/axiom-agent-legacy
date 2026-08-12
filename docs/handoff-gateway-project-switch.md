# Handoff — gateway live project switching + /projects menu

Done 2026-08-12 on `feat/gateway-project-switch` (7 commits), implemented under
the Feature Implementation Loop v2 (plan -> self/external plan review (3
rounds) -> implement -> self/external implementation review -> summary).

## What was done

- `src/gateway/active-project.ts` (NEW): per-channel active-project store
  (Memory + File JSON with atomic rename writes + self-heal), per-project
  generation counter, shared `PROJECT_NAME_RE`/`isValidProjectName`,
  `resolveProjectRoot`.
- `src/gateway/channel-index.ts`: `removeWhere(predicate)` on both impls
  (JSON persists).
- `src/gateway/completion.ts`: per-call `projectRoot` override threaded
  through bwrap mount, cwd, AXIOM_PROJECT_ROOT, `[sandbox-confined]` prefix;
  fail-closed preserved; fake runner records projectRoot.
- `src/gateway/gateway.ts`: GatewayDeps `activeProjects` injection seam
  (default file store under profile home); command ctx gains activeProject /
  activeProjects / dropProjectSessions; agent branch resolves the channel's
  active project: composite session key `channel:project:generation`, anchored
  per-call root, stale-entry self-heal (invalid name or missing dir -> store
  cleared + composite mapping dropped + unanchored).
- `src/gateway/commands/projects.ts`: friendly menu (active marked, actions,
  unanchored status), `use <name>` live switch, `rm` hardened (NAME_RE +
  containment) and wired to store.removeProject + dropProjectSessions.
- `src/gateway/commands/help.ts`: /projects use advertised.

## What was verified

- Unit: 210 gateway tests green (22 files), incl. 23 new: store (6), removeWhere
  (2), command menu/use/rm (7), per-call override (2), router switching
  (a-g,h: 6... 7). Every behavior change is test-first; the implementation
  reviewer MUTATION-TESTED three core behaviors (composite key, dropProjectSessions,
  override) — each mutation broke exactly the expected tests.
- Full gate: `./test.sh` 4630 passed / 14 failed — the 14 are ONLY the
  documented sandbox known-fails (4603-worker-recovery x4, 4685-daemon-client-modes x9,
  daemon-serialized-refine x1). biome clean, tsgo clean.
- External reviews: plan review 3 rounds (R1 82/100 denied -> fixed 4 cites;
  R2 denied mechanism gap -> removeWhere/dropProjectSessions; R3 denied at the
  session-file layer -> per-project generation). Implementation review:
  APPROVED 96/100; its flagged risk (unvalidated stored names) was applied as
  a follow-up commit with test (h).
- Not live-tested against real Telegram/Discord (sandbox has no bot tokens);
  transport-level behavior is covered by the existing fake-client suites.

## Follow-ups (out of scope, honest)

- Inline tappable menus (Telegram callback_query / inline keyboards): a
  separate transport feature (sendMessage reply_markup, callback parsing,
  answerCallbackQuery, editMessage).
- Profile-switching stays boot-scoped (restart-driven); true multi-profile
  gateway routing is a larger architecture change.
- `listProjects` duplicated in the CLI projects command (different IO
  abstraction); could share later.
