# Handoff — Skills that learn procedural memory (step 1: skill capture)

**Branch:** `feat/skill-capture` (isolated worktree at `.worktrees/skill-capture`)
**Base:** baseline 68a3f31ae (prime-agent v0.7.2 fork)

## What was done

Implemented step 1 of the feature (ADR-0020): capturing a completed task that
is flagged reusable into a validated, provenance-bearing markdown skill that
bundles the task prompt + ordered steps, persisting it without overwriting
existing skills, verifying it loads via the real skill loader, and offering the
result.

- `packages/coding-agent/src/core/skill-capture/` — `types.ts`, `document.ts`
  (`slugify` + `buildSkillDocument`, reusing `skills.ts` validators),
  `capture.ts` (`persistCapturedSkill` no-overwrite + `verifyCapturedSkill`
  via `loadSkillsFromDir`), `index.ts`.
- `packages/coding-agent/src/cli/skill-capture-command.ts` — `axiom skill-capture`
  subcommand, wired into `main.ts` after `gateway`.
- `packages/coding-agent/src/core/skills.ts` — exported `validateName`,
  `validateDescription`, `MAX_NAME_LENGTH` (single source of truth) — only
  three `export` additions, no behavior change.
- `packages/coding-agent/test/skill-capture.test.ts` — 24 vitest tests.
- `docs/adr/ADR-0020-skill-capture.md`, `CONTEXT.md` (new term),
  `docs/handoff-skill-capture.md`, `docs/skill-capture-log.md`.

## What was verified, and how

- **Unit (24/24)** — `test/skill-capture.test.ts`: slug rules, build/validate,
  provenance round-trip, no-overwrite persistence, and **verification via the
  real `loadSkillsFromDir` returning zero diagnostics** (non-tautological).
- **Regression** — related suites (`skills`, `builtin-skills`, `frontmatter`,
  `refinement`, `sdk-skills`) 148/148 green.
- **Full `./test.sh`** — only pre-existing sandbox known-fails, identical on the
  pristine baseline: 4603/4685 EXDEV (node hard-link cross-device in this btrfs
  sandbox) and `daemon-serialized-refine` (fails on pristine baseline too),
  plus one `ipython-bootstrap` timing flake that passes on re-run and on
  baseline. No new failures attributable to this change.
- **biome** clean; **tsgo --noEmit** clean.
- **End-to-end** real run: captured `fix-regression-test-first` SKILL.md,
  verified 0 loader diagnostics, printed the offer.

## What is deliberately NOT in this step (later steps)

Automatic flagging ("agent detects a task was reusable"), the AST-level
security audit of third-party skills before running them, and the skills
hub/sync over agentskills.io. All extend `core/skill-capture` and are deferred.
