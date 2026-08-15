# Handoff — 2026-08-15 (ownership lattice: fence green, consumers wired)

## Done

1. **Lattice core implemented, fence green** (`3a877e3de`, ADR-0081, issue
   #55): `classifyPath` (most-specific boundary-safe root over lexical
   segments, tie → stricter layer, unmapped → outside), `admitWrite` (pin
   refused for every actor; learning actor curator-only via
   `LEARNING_ACTOR_TOOLSET` = memory.apply / memory.stage / skill.capture /
   skill.install; outside fails closed for both actors), `defaultLatticeConfig`
   built from the loader constants (CONFIG_DIR_NAME, the shared
   captured/curator/consolidation dir names, `consolidationAuditPath`, the
   repo-floor signature SOUL.md + packages/ + test/), and
   `installCapturedSkill` (curator target: recursive no-overwrite copy +
   real-loader verify with rollback on failure; protected: manual `cp -r`
   printed, never run; pin/outside: hard refusals). The throwing stub is
   gone; the 29-test fence passes against the real bodies.
2. **Consumers wired** — all four from the ADR-0081 plan:
   - `/learn --install`: the parse contract extended to `--force`/`--install`;
     the report states the lattice verdict (curator staging) and the install
     path; `--install` routes a fresh or already-staged capture through
     `installCapturedSkill` into `<AXIOM_HOME>/curator-skills`.
   - ADR-0027 hook: after a verified capture the hook auto-installs into
     curator-skills (curator → curator, silent, audited by the notification);
     refused installs stage only, with "Not installed (…)" in the message.
   - `resources_discover`: the extension emits curator-skills as a skillPath
     when the dir exists (absent costs nothing); user/project skills win
     name collisions via the loader's first-wins order.
   - Consolidation write paths: the hook admits `memory.apply`
     (harnessStateDir) and `memory.stage` (pendingDir) through the lattice
     before writing; a refusal is audited via the witness append (the
     sanctioned primitive — not itself lattice-routed) and nothing is
     written. The CLI is operator-routed and unchanged.
3. **CONTEXT.md**: "Ownership lattice" term added; the Skill capture term now
   names the install routes.
4. **One meaning, one house**: `CAPTURED_SKILLS_DIR_NAME`,
   `CURATOR_SKILLS_DIR_NAME`, `CONSOLIDATION_DIR_NAME` exported from the
   lattice module; the consolidation CLI + extension now use the constant
   instead of the inline `"consolidation"`.

## How it was verified

- Red-first: the 6 new consumer tests + the parse-contract updates failed
  against the pre-wiring code before the implementation landed; the fence
  stayed green from the core commit onward.
- 143 tests green across the seven directly-affected suites (fence,
  skill-capture-learn, extensions/skill-capture, extensions/memory-
  consolidation, memory-consolidation core + command, skill-capture core).
- `npx biome check .` clean on every touched file (4 pre-existing infos in
  unrelated test files, none touched); `npx tsgo --noEmit` clean.
- Full floor (`./test.sh`, detached, scrubbed env, log:
  `/tmp/floor-lattice-impl-2.log`) green twice-verified: coding-agent 430
  files (5848 passed + 116 skipped), tui 12/60, kernel 12/60+27 skipped,
  process-stress 2/13+8 skipped; auth.json restored. One parallel-floor
  contention failure appeared in the first run
  (daemon-supervisor-process "keeps client-owned workers hidden"); it passed
  in isolation and on the full re-run, and its workers boot with
  `noExtensions: true`, so the lattice code cannot reach it.

## Notes

- Issue #55 stays open per the directive: the close ritual (merge to main,
  audit comment, close) is the next session's first step.
- `docs/hermes-improvements.html` is still untracked — not mine, left alone.
- Owner's calls still open from the prior handoff: #52 tag decision +
  optional spawn-merge hardening; delete `feat/autonomy-direction-adr-0076`
  (tip == main).

## Next

1. Close ritual for #55: merge `feat/ownership-lattice` to main, post the
   audit comment (merge commit, ADR-0081, this handoff), close the issue,
   delete the stale branch.
2. Session recall (#56, ADR-0082) — the next ADR-0078 port-order step.
3. Owner's calls above.

## Next-session prompt (ready to paste)

> You're in /home/mustbearn/Projects/axiom-agent, branch feat/ownership-lattice,
> pushed (3a877e3de) — the ADR-0081 lattice is implemented, the 29-test fence is
> green, and all four consumers are wired (/learn --install + verdict, the
> ADR-0027 hook auto-install, the resources_discover emission for
> curator-skills, admitWrite on the consolidation apply/stage paths). Full floor
> verified (log: /tmp/floor-lattice-impl-2.log; one contention-only failure on
> the first run, green in isolation and on re-run). Issue #55 is still open.
>
> Read SOUL.md, AGENTS.md, docs/handoff.md, ADR-0081 first. Run the close
> ritual for #55: merge feat/ownership-lattice to main, post the audit comment
> (merge commit, ADR-0081, handoff), close the issue, delete the stale branch.
> Then pick up session recall (#56, ADR-0082) — the next ADR-0078 port-order
> step. Owner's calls still open: #52 tag decision, and deleting
> feat/autonomy-direction-adr-0076 (tip == main).
