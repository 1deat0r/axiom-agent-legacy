# Handoff — Skills that learn procedural memory (steps 1–2: capture + security audit)

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
- `docs/adr/ADR-0020-skill-capture.md` + `ADR-0021-skill-audit.md`,
  `CONTEXT.md` (new terms), `docs/handoff-skill-capture.md`, `docs/skill-capture-log.md`.

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

## Step 2 — AST-level security audit (ADR-0021)

Added the security half (mirrors Hermes `skills_ast_audit` + `skills_guard`):
statically screen a skill before running/installing a third-party one.

- `packages/coding-agent/src/core/skill-audit/` — `types.ts`, `python-ast.ts`
  (subprocess `python3` + real `ast` walker), `rules.ts` (JS/shell/markdown
  structural scanners), `audit.ts` (walk + dispatch + `chooseVerdict`),
  `index.ts`.
- `axiom skill-audit <dir> [--json]` CLI + `main.ts` wiring.
- Python AST flags dynamic code, subprocess/dangerous calls, network egress
  (sends block, reads warn), file mutation, secret reads, sensitive imports;
  JS/shell/markdown scans cover pipe-to-shell, destructive commands, reverse
  shells, privilege, eval. Conservative verdict: BLOCK / WARN / ALLOW.
- `test/skill-audit.test.ts` — 12 tests; audit+capture suites 37/37 green;
  biome + tsgo clean.
- Verified end-to-end: evil→BLOCK, benign→ALLOW, real bundled `websearch`→BLOCK
  (network egress, conservative default — first-party skills are operator
  allowlisted).

## What is deliberately NOT in this feature yet (later steps)

Automatic flagging ("agent detects a task was reusable"), and the skills
hub/sync over agentskills.io. Both extend what is built here and are deferred.
