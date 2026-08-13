# Handoff — `axiom skill-check`: validate hand-written skills with the real loader

Branch: `feat/skill-check` (isolated worktree `.worktrees/skill-check`).
Base: `origin/main` @ `2da1e6c74` (includes connectors-menu, session budget, streaming v2).
ADR: ADR-0037.

## What was done

The reported warning was real and loader-fatal: `~/.agents/skills/tui-pty-testing/SKILL.md`
(hand-written by an earlier autonomous run) had no YAML frontmatter, so the loader
emitted `description is required` and **silently dropped the skill** — it never
appeared in `available_skills`.

1. **Fixed the incident skill in place** (machine-local, outside the repo): added
   proper frontmatter (`name: tui-pty-testing` + a routing-focused `description`
   under the 1024-char limit). Verified with the real loader: it now loads
   (`42 loaded` from `~/.agents/skills`, zero missing-description diagnostics).
2. **New `axiom skill-check [dir ...] [--json] [--strict]`** so this cannot
   recur silently:
   - `src/core/skill-check/check.ts` — `runSkillCheck(dir, cwd?)` runs the REAL
     `loadSkills` path (explicit skill path, defaults disabled, collision dedupe
     on) and classifies from its output: a diagnostic whose file is not loaded =
     **rejected**; a loaded file's diagnostics = **warnings**. No loader logic is
     re-implemented, so the check cannot drift.
   - `src/cli/skill-check-command.ts` — dispatches from `main.ts`; no dir args
     check the default skill dirs (agent + project; missing project dir is
     skipped, matching the loader); explicit missing dirs error like skill-audit;
     exit code 1 on any rejection; `--strict` also fails on warnings; `--json`
     prints a machine-readable report.
3. **skill-creator skill updated** (in-repo): Verification step 1 is now
   `axiom skill-check <dir>` with exit 0 required before a skill is done.

## What was verified (unit / mock / live)

- **Unit**: 17 new tests (`test/skill-check.test.ts`) — missing frontmatter,
  empty description, name mismatch (warning, not rejection), collision loser,
  ignore-file exclusion, root loose `.md`, nested non-SKILL `.md`, missing dir,
  plus CLI handling (help, OK path, exit 1, --json, --strict, nonexistent dir,
  no-arg defaults). Red first, then green.
- **Full suite**: `./test.sh` → 4818 passed; the 14 failures are EXACTLY the
  documented sandbox known-fails (daemon-serialized-refine 1, 4603-worker-recovery 4,
  4685-daemon-client-modes 9). Zero regressions. `biome` and `tsgo --noEmit` clean.
- **Live**: `axiom skill-check` run against the real skill dirs — `~/.agents/skills`
  42/42 OK, `~/.axiom/agent/skills` 1/1 OK, `packages/coding-agent/skills` 13/13 OK.
  A synthetic replica of the incident (frontmatter-less SKILL.md) is detected:
  `FAILED … rejected: …/no-frontmatter-skill/SKILL.md — description is required`,
  exit 1. The fixed `tui-pty-testing` skill was independently confirmed to load
  via `loadSkillsFromDir` on the real directory.

## Remaining follow-ups

- `~/.agents/skills` is wired as a session skill path outside the default dirs;
  running `skill-check` there is manual (or via `--skill`-style config). The
  default-dir check covers the loader's own defaults.
- Rebuild dist (`npm run build` in packages/coding-agent) after merging so the
  installed `axiom` CLI exposes `skill-check`.
- The loader itself is unchanged (tolerance is intentional); only the write-time
  check loop is new.
