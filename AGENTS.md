# Axiom — agent operating guide

## Soul

Read root `SOUL.md` first — the creed of the agent who develops this repo:
test-first, honest verification, CONTEXT.md vocabulary, ADR + handoff +
tracker rituals, the money thesis. It binds every coding-agent run here.

## The baseline

This repo is a fork of **prime-agent v0.7.2** (PrimeIntellect-ai/prime-agent,
MIT) — the baseline (ADR-0015). Upstream is `git remote upstream`; merge
upstream `main` routinely. The pi-fork line (pi v0.84.1 + the twelve axiom
commits) lives on `archive/pi-v0.84.1` (remote `upstream-pi`); its capabilities
port per `docs/ports.md`. Both archives are seed corn, not working trunks.

## Code quality (prime-agent's rules, binding here)

- No `any` unless absolutely necessary. Erasable TypeScript only. No inline
  imports (`await import()`, dynamic type imports). Top-level only.
- Relative imports use `.js` specifiers (NodeNext), never `.ts`.
- Read files in full before wide-ranging changes. Check node_modules for
  external API types; don't guess.
- Never modify `packages/ai/src/models.generated.ts` directly; update
  `packages/ai/scripts/generate-models.ts`, then regenerate.
- No emojis in commits. Technical prose only, direct.

## Commands (the floor)

- Before committing: `./test.sh` must pass, `npx biome check .` clean,
  `tsgo --noEmit` clean. Never run the full `npm test` directly outside
  `./test.sh` — it includes e2e paths that activate on endpoint/auth env vars.
  `./test.sh` scrubs live-agent env (`PRIME_AGENT_INTERNAL_*`, `RLM_*`) and
  API keys so the suite runs neutral.
- For a single vitest file:
  `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/<file>.test.ts`
  from the package root. `packages/tui` uses `node:test` instead.
- Sandbox note: daemon/worker suites that hard-link the node binary
  (4603/4685) fail with EXDEV in this sandbox's btrfs subvolume layout and
  pass on normal filesystems; record as known-fail with reason, never mute.

## Ritual (from SOUL.md, binding here)

- Red first, green after. Commit with a message that tells the story; push to
  origin. One capability, one ADR, one handoff.
- Decisions are ADRs in `docs/adr/` (0015 continues the series).
- Issues and specs live as GitHub issues via `gh` — see
  `docs/agents/issue-tracker.md`; labels in `docs/agents/triage-labels.md`;
  domain vocabulary in root `CONTEXT.md` + `docs/adr/`.
- End autonomous runs with a `docs/handoff.md` that says what was done, what
  was verified, and how (unit / mock / live — never blurred).
