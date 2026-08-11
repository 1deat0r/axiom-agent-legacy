# Axiom — agent operating guide

## Soul

Read root `SOUL.md` first — the creed of the agent who develops this repo:
test-first, honest verification, CONTEXT.md vocabulary, ADR + handoff +
tracker rituals, the money thesis. It binds every coding-agent run here.

## The baseline

This repo is a fork of **pi v0.84.1** (earendil-works/pi, MIT) — the baseline
(ADR-0013). Upstream is `git remote upstream`; merge upstream `main`
routinely. The archived from-scratch tree lives on
`archive/from-scratch-v0.23`; its capabilities port per `docs/ports.md`.

## Code quality (from pi's AGENTS.md, binding here)

- No `any` unless absolutely necessary. Erasable TypeScript only (no enums,
  parameter properties, namespaces — Node strip-only mode).
- No inline imports (`await import()`, dynamic type imports). Top-level only.
- Read files in full before wide-ranging changes. Check node_modules for
  external API types; don't guess.
- Never modify `packages/ai/src/models.generated.ts` directly; update
  `packages/ai/scripts/generate-models.ts`, then regenerate.
- No emojis in commits. Technical prose only, direct.

## Commands (the floor)

- Before committing: `./test.sh` (the non-e2e suite, isolated HOME, no API
  keys) must pass, `npx biome check .` clean, `tsgo --noEmit` clean. Never
  run the full `npm test` directly — it includes e2e tests that activate on
  endpoint/auth env vars.
- For a single vitest file: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/<file>.test.ts`.
- `packages/tui` uses `node:test`: `node --test test/<file>.test.ts` from the
  package root.
- The build (`npm run build`) regenerates the ai model data (network) and
  produces the `dist/` the coding-agent probe tests need — run it when a
  clean checkout fails probe tests.

## Ritual (from SOUL.md, binding here)

- Red first, green after. Commit with a message that tells the story; push to
  origin. One capability, one ADR, one handoff.
- Decisions are ADRs in `docs/adr/` (0013 continues the series).
- Issues and specs live as GitHub issues via `gh` — see
  `docs/agents/issue-tracker.md`; labels in `docs/agents/triage-labels.md`;
  domain vocabulary in root `CONTEXT.md` + `docs/adr/`.
- End autonomous runs with a `docs/handoff.md` that says what was done, what
  was verified, and how (unit / mock / live — never blurred).
