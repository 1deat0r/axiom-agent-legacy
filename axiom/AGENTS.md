# Axiom — operating instructions (Hermes baseline)

Operator-approved instruction file for coding agents working in this repo.
This is Axiom's layer on top of the Hermes tree; the repo-root `AGENTS.md`
(Hermes's) is the authoritative development guide for the Python core.

## Soul

Read axiom/SOUL.md first — the creed. Test-first, honest verification,
axiom/CONTEXT.md vocabulary, ADR + handoff + tracker rituals. It binds every
coding-agent run here.

## The baseline

This repo is a hardfork of Hermes Agent (NousResearch/hermes-agent, MIT) at
HEAD (ADR-0087). `upstream` = NousResearch/hermes-agent; merge upstream `main`
routinely. The root tree is Hermes's, untouched; Axiom's own layer lives under
`axiom/`. The prime-agent era (`archive/prime-v0.7.2`) and the pi fork
(`archive/pi-v0.84.1`) are archived seed corn, not working trunks — their
capabilities port per axiom/docs/ports.md.

## Code quality (binding here)

- No `any` unless absolutely necessary. Erasable TypeScript only. No inline
  imports (`await import()`, dynamic type imports). Top-level only.
- Relative imports use `.ts` specifiers (Node 26 type-stripping does not rewrite
  `.js` → `.ts`; `tsc --noEmit` reads `.ts` via `allowImportingTsExtensions`).
- Never modify generated files directly; update the generator, then
  regenerate.
- No emojis in commits. Technical prose only, direct.

## Commands (the floor)

Hermes baseline:
- Dev env: `source .venv/bin/activate` (probes `.venv`, then `venv`, then
  `$HOME/.hermes/hermes-agent/venv`).
- Python tests: `scripts/run_tests.sh`.
- TS (ui-tui / web / apps): npm scripts under the respective package.
- Python requires `>=3.11,<3.14` — 3.14 is refused (Rust transitives have no
  cp314 wheels yet). Use a venv on 3.12/3.13.

Axiom's TS sovereign layer (`axiom/sovereign/`): `node --test`,
`tsc --noEmit`.

## Ritual (from SOUL.md, binding here)

- Red first, green after. Commit with a message that tells the story; push to
  origin. Never force-push without operator sign-off (the re-foundation
  rewrote main).
- Decisions are ADRs in axiom/docs/adr/ (0087 continues the series).
- Issues live on GitHub via `gh` (origin 1deat0r/axiom-agent): role label at
  create, close only after the audit comment (merge commit, ADR, handoff).
  See axiom/docs/agents/issue-tracker.md and triage-labels.md.
- End autonomous runs with axiom/docs/handoff.md: what was done, what was
  verified, and how (unit / mock / live — never blurred).
