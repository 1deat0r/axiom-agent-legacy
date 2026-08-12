# Feature Implementation Log — Skills that learn procedural memory (step 1: skill capture)

> Running log. The final summary.html is built ONLY from this log.

## Preflight
- [x] Scanned AGENTS.md/CONTEXT.md/docs; conventions: vitest (`test/*.test.ts`), biome, tsgo, NodeNext `.js` imports.
- [x] Located skill machinery: `src/core/skills.ts` (validateName/Description, loadSkillsFromDir), `src/utils/frontmatter.ts`, refinement harness (`core/refinement`), CLI command seam `handleGatewayCommand` in main.ts.
- [x] Feature (first step) sentence + success criterion defined. Assumption recorded.
- [x] Created isolated worktree `.worktrees/skill-capture` on branch `feat/skill-capture` from baseline 68a3f31ae; symlinked node_modules per existing worktree convention.
- [x] Opened this running log.

## 1. Plan (step 1 scope)

**Goal sentence:** When a completed task is flagged reusable, generate a validated, provenance-bearing
markdown skill that bundles the task prompt + its ordered steps, persist it to a skills directory, verify
it loads via the existing skill loader, and offer the result — as a core `skill-capture` module + a
standalone `axiom skill-capture` CLI subcommand, all unit-tested.

**Assumption (recorded):** This run implements ONLY the mechanical first step (capture a flagged task →
bundled skill + provenance + no-overwrite install safety + real-loader verification). Automatic
"agent detects reusability" heuristics, AST-level security audit of third-party skills, and the
skills hub/sync (agentskills.io) are LATER steps of the feature. "Flag as reusable" here is explicit
(via CLI args / a JSON capture spec); auto-flagging is a later step. `self-check`: reviewers may verify.

**Files:**
- `packages/coding-agent/src/core/skill-capture/types.ts` — TaskCapture/TaskStep/SkillProvenance/CapturedSkillDocument/result types.
- `.../skill-capture/document.ts` — slugify + buildSkillDocument (validate name/description, render frontmatter+body).
- `.../skill-capture/capture.ts` — persistCapturedSkill (no-overwrite) + verifyCapturedSkill (reuse loadSkillsFromDir).
- `.../skill-capture/index.ts` — public exports.
- `packages/coding-agent/src/cli/skill-capture-command.ts` — parseSkillCaptureArgs (pure) + handleSkillCaptureCommand (reads steps JSON/JSONL, builds provenance, writes, verifies, prints offer).
- `packages/coding-agent/src/main.ts` — wire `handleSkillCaptureCommand` (return-early, like gateway).
- `packages/coding-agent/test/skill-capture.test.ts` — vitest coverage.
- `docs/adr/ADR-0020-skill-capture.md` — ADR for the capability.
- `docs/handoff.md` — autonomous-run handoff (what/verified/how).
- `CONTEXT.md` — add vocabulary term.

**Ordered steps + verification:**
1. core types+document (`document.ts`) → vitest document tests.
2. capture.ts (persist/verify) → vitest capture tests (no-overwrite, loadSkillsFromDir discoverable).
3. cli command + main.ts wiring → command tests + `./test.sh` ambiance + biome + tsgo.
4. ADR + CONTEXT.md + handoff → `./test.sh` green.
Commit per green step.

**Test strategy:** new vitest file `test/skill-capture.test.ts`; each behavior change (build/validate/persist/verify/parse) has a test that fails without it. Reuse real `loadSkillsFromDir` for the "would fail without" discoverability proof.

**Risks/edges:** name/description rule parity with skills.ts (keep consts in sync); overwrite protection; steps-file parse errors; empty prompt; provenance always present; skill name collisions; NodeNext `.js` imports; no `any`; biome clean.

## 2. Self-review of plan

Scored against rubric (5x20=100): Correctness, Fit, Testability, Risk, Clarity.

- Correctness 4/5: covers build→persist→verify→offer end-to-end incl. error paths (validation errors, overwrite, bad steps file). Weakness: capture provenance `createdAt`/`sessionId` sourcing from CLI is thin — acceptable for step 1 but noted.
- Fit 4/5: reuses skill name/desc rules + real loadSkillsFromDir + gateway-style CLI seam. Weakness (FOUND): I duplicated name/description validation rules instead of exporting/reusing `validateName`/`validateDescription` from skills.ts — risk of rule drift; plan must reuse them (Fit/Correctness). FIXED: export the validators from skills.ts and import them.
- Testability 4/5: each behavior change has a freshing test. Weakness: `verifyCapturedSkill` depends on `loadSkillsFromDir` reading a real dir — fine (uses tmpdir) but must not require an agent dir/home; keep it pure per-dir.
- Risk 4/5: overwrite, name parity, parse errors covered. Weakness (FOUND): no explicit test that provenance survives round-trip through the real loader and that metadata is preserved; add one. Also: `--out` default cwd could collide with repo — require explicit `--out`.
- Clarity 4/5: a stranger could run `axiom skill-capture --help`. 

Fix summary: (a) reuse skills.ts validators (export them) instead of duplicating rules; (b) add provenance round-trip test; (c) require explicit --out. Re-check after fixes → no dimension <4/5 (all at 4–5).

## 3. External review of plan — Round 1 (skeptical senior engineer)

Reviewer framing: reading the plan cold.

- Correctness 4: "End-to-end build→persist→verify→offer with explicit error paths; accept that step 1 takes an explicit flag (auto-flag deferred)."
- Fit 4: "Reuses gateway CLI seam and real loader; still plans to hand-roll name rules — must reuse skills.ts validators." → Already fixed in self-review (b).
- Testability 5: "One failing-test-per-behavior; the loadSkillsFromDir discoverability assertion is the strong one."
- Risk 4: "Overwrite, name parity, bad steps file covered. Add: large steps/description length guard is in validators; prompt-empty guard present."
- Clarity 5: "Runnable via --help; each step has a verification action."
Total: 86/100 → below 90. Cited issues: (1) name/desc rule duplication must be removed (b) — the self-review already fixed this; (2) require explicit --out (self-review c); (3) NEW: `verifyCapturedSkill` should return which skill loaded (name+description) so the assertion is non-tautological.

Fixes applied: (1) reuse exported validators from skills.ts; (2) explicit --out required; (3) verify returns the loaded skill name/description (non-tautological proof).
Re-submit → Round 2.

## 3b. External review of plan — Round 2

Reviewer re-read after fixes:
- Correctness 5, Fit 5 (rules reused; seam reused), Testability 5 (non-tautological verify proof), Risk 5 (overwrite+explicit out+guards), Clarity 5.
Total: 100/100 — APPROVED. Proceeding to implementation.

## 4. Implement (red/green per step)
## 4. Implement (red/green)
- [x] Exported validateName/validateDescription + MAX_NAME_LENGTH from skills.ts (reuse, single source of truth).
- [x] Created core module: types.ts, document.ts (slugify + buildSkillDocument), capture.ts (persist no-overwrite + verify via loadSkillsFromDir), index.ts.
- [x] Created CLI `skill-capture` (src/cli/skill-capture-command.ts) + wired into main.ts after gateway.
- [x] Tests: test/skill-capture.test.ts — 24 tests. Fixed 3 test-side bugs + 1 syntax bug + PersistResult discriminant + flag narrowing; biome clean, tsgo clean.
- [x] End-to-end demo: real run captured `fix-regression-test-first` SKILL.md, verified 0 loader diagnostics, printed offer.
## 4b. Implementation verification (recorded)
- [x] 24/24 skill-capture tests green; related suites (skills/builtin-skills/frontmatter/refinement/sdk-skills) 148/148 green.
- [x] Full `./test.sh`: only pre-existing sandbox known-fails (4603/4685 EXDEV + daemon-serialized-refine, identical on pristine baseline) + one ipython-bootstrap timing flake (passes on re-run + on baseline). No new failures from this change.
- [x] biome clean, tsgo clean. End-to-end demo captured a real, verifiable skill.
- [x] Docs: ADR-0020, CONTEXT.md term, handoff-skill-capture.md (named, per convention; shared handoff.md left untouched).
