# ADR-0037 — Skill check: validate hand-written skills with the real loader

## Status
Accepted (2026-08-13)

## Context
A skill an agent writes by hand ships straight into a scanned skills directory
(`~/.agents/skills/`). The loader requires a non-empty `description` in a
`SKILL.md`'s frontmatter; a file without one is dropped from the prompt with
only a `"description is required"` warning diagnostic — no failure, no
rollback, no visible error at write time. That happened with `tui-pty-testing`
(created 2026-08-12 with no frontmatter): the next sessions never saw the
skill in `available_skills`, and the only trace was the warning.

The automated pipeline already guards this: `skill-capture` validates with the
loader's own rules (`validateDescription`/`validateName`) before materializing
a document, and `verifyCapturedSkill` re-checks it against the real loader.
The gap is only the hand-written path — nothing validates a `SKILL.md` an
agent (or the operator) writes directly, and the skill-creator skill's
verification was a prose checklist that a run could skip.

Options considered:

1. **Harden the loader** — turn the warning into an error. Rejected: the
   loader's tolerance is correct (one malformed third-party skill must not
   break a session); the failure mode to fix is at write time, not read time.
2. **A write-side installer** — a skill-install command that refuses files
   without descriptions. Helpful, but it does not cover skills written
   directly into a scanned directory (the actual incident) and duplicates
   loader logic.
3. **A check command derived from the loader itself** — `axiom skill-check`
   runs the real load path over a directory and reports every file the loader
   would drop, with a non-zero exit. Covers every write path (hand-written,
   captured, third-party), cannot drift from loader semantics, and is cheap to
   run in a loop. Chosen.

## Decision
- New `runSkillCheck(dir, cwd?)` in `src/core/skill-check/check.ts`. It calls
  the real `loadSkills` with the directory as an explicit skill path
  (`includeDefaults: false`), so name-collision dedupe and all diagnostics
  behave exactly as in a session. A file is **rejected** iff the loader
  emitted a diagnostic for its path but did not load it; a loaded file's
  diagnostics are **warnings**. Files the loader never saw (ignored, dot-dirs,
  `node_modules`) are not reported. Nothing is re-implemented: the check is a
  pure function of the loader's output.
- New `axiom skill-check [dir ...] [--json] [--strict]` CLI
  (`src/cli/skill-check-command.ts`), dispatched from `main.ts` alongside the
  other skill commands. No directory argument checks the default skill dirs
  (agent `~/.axiom/agent/skills` + project `<cwd>/.axiom/agent/skills`). Exit
  code 1 when any skill would be dropped; `--strict` also fails on warnings;
  `--json` prints a machine-readable report.
- The skill-creator skill's Verification step now requires `axiom skill-check
  <dir>` with exit 0 before the skill is considered done.
- The incident skill `tui-pty-testing` was fixed directly: proper frontmatter
  (`name` + routing-focused `description`), verified to load via the real
  loader.

## Consequences
- A dropped-skill incident is now caught by one command at write time, and the
  report names the exact loader reason (`description is required`, parse
  failure, `name "x" collision`), so the fix is immediate.
- The check shares the loader's blind spots by construction — a file the
  loader would skip (ignore files, dot-dirs) is not reported. That is the
  intended semantic: the check answers "what would the next session lose",
  not "is every file on disk well-formed".
- Cost: one small core module, one CLI, one test file (17 cases), no change to
  the loader itself.
