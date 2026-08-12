# ADR-0024: Skill capture (procedural-memory skills, step 1)

**Status:** accepted
**Date:** 2026-08-12
**Implements:** step 1 of the "skills that learn procedural memory" capability

## Context

Hermes turns hard-won task sequences into durable, self-improving skills and
shares them via a hub + an open standard (agentskills.io); its toolchain is
`skill_manager_tool.py`, `skills_hub.py`, `skills_sync.py`, plus provenance and
an AST-level security audit before running third-party skills.

Axiom already ships static skills (`packages/coding-agent/skills/`) and a
manual `skill-creator`, and learns via the refinement harness (lineage). The
gap is the *automatic* capture: after a completed task is flagged as reusable,
turn it into a skill that bundles the task's prompt + the ordered steps taken
during that session. The full Hermes surface also includes an AST-level
security audit for third-party skills and a hub/sync standard; those are
separate later steps.

This ADR pins the **mechanical first step** only: capture a flagged-reusable
task into a validated, provenance-bearing markdown skill, verify it loads via
the real skill loader, and offer the result.

## Decision

A **skill capture pipeline** with two surfaces:

- **Core module** `packages/coding-agent/src/core/skill-capture/`:
  - `buildSkillDocument(capture)` renders a `SKILL.md` from a task capture
    (prompt + ordered steps + provenance). Name/description are validated
    **reusing** `validateName`/`validateDescription`/`MAX_NAME_LENGTH` from
    `skills.ts` (single source of truth — a generated document can never be
    silently dropped by the loader). A suggested name is normalized via
    `slugify` to the Agent Skills alphabet.
  - `persistCapturedSkill(dir, doc)` writes `<dir>/<name>/SKILL.md`, **refusing
    to overwrite** an existing skill (a captured skill must never clobber a
    hand-written one).
  - `verifyCapturedSkill(dir, name)` re-runs the **real** `loadSkillsFromDir`
    and asserts the skill loads with **zero** loader diagnostics — the
    non-tautological proof the document is genuinely valid and discoverable.
- **CLI subcommand** `axiom skill-capture` (wired into `main.ts` after
  `gateway`): takes `--prompt`, `--description`, `--out` (required) plus
  `--name`, `--steps-file` (JSON/JSONL of steps), `--source`, `--session-id`,
  `--trigger`, `--json`; builds provenance (`metadata.provenance`), persists,
  verifies, and prints an offer to treat the result as a reusable skill.

**Provenance** is always captured into frontmatter `metadata.provenance`
(source, createdAt, optional sessionId/trigger).

## Honest boundary (recorded, not faked)

This increment is the **capture mechanics only** — it requires an explicit
"flag as reusable" (via CLI args / a JSON capture). The remainder of the
Hermes surface is deferred and will extend this module:

- automatic flagging — the agent detecting that a completed task was reusable;
- an **AST-level security audit** before running third-party skills (keeps
  Axiom's safety ethic intact when skills are shared/installed);
- the skills hub/sync over agentskills.io.

## Consequences

- A flagged task becomes a durable, versionable, self-improving skill; every
  capture carries provenance.
- Reusing the loader validators keeps capture and load in agreement.
- No-overwrite persistence protects existing skills.
- The new module is pure and unit-tested (vitest); end-to-end verified via the
  real `loadSkillsFromDir`.
