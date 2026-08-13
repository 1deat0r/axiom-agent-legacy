# Skill check — catch hand-written skills the loader would silently drop

Date: 2026-08-13 · Branch: feat/skill-check · ADR: ADR-0037

## Problem

A skill an agent writes by hand ships straight into a scanned skills directory.
The loader requires a non-empty `description` in a `SKILL.md`'s frontmatter;
without one the file is dropped from the prompt with only a `description is
required` warning diagnostic. `~/.agents/skills/tui-pty-testing/` (created
2026-08-12 with no frontmatter) hit exactly this: the skill never appeared in
`available_skills`, and the only trace was the warning. skill-capture already
validates on the automated path; the hand-written path had nothing.

## What changed

- `packages/coding-agent/src/core/skill-check/check.ts` (new): `runSkillCheck`
  runs the real `loadSkills` path over one directory and classifies the output —
  rejected = a diagnostic whose file was not loaded (missing/empty description,
  parse failure, collision loser); warnings = diagnostics on loaded files. The
  check is a pure function of the loader, so it cannot drift from loader
  semantics; ignored/dot/node_modules files are naturally not reported.
- `packages/coding-agent/src/cli/skill-check-command.ts` (new): `axiom
  skill-check [dir ...] [--json] [--strict]`, dispatched from `main.ts`. No dir
  argument checks the default skill dirs (agent + project); a missing default
  dir is skipped (loader behavior), an explicit missing dir errors. Exit 1 when
  any skill would be dropped; `--strict` fails on warnings too; `--json` for
  scripting.
- `packages/coding-agent/skills/skill-creator/SKILL.md`: Verification now
  requires `axiom skill-check <dir>` with exit 0.
- Incident skill `tui-pty-testing` fixed in place with proper frontmatter;
  confirmed loaded by the real loader.

## Verified

17 new tests (red-first); full `./test.sh` 4818 passed with only the documented
sandbox known-fails; biome + tsgo clean; live runs over `~/.agents/skills`
(42/42), `~/.axiom/agent/skills` (1/1), `packages/coding-agent/skills` (13/13)
all OK, and a frontmatter-less replica of the incident is detected with exit 1.
