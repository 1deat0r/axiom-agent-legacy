# Handoff — re-foundation on the Hermes baseline (ADR-0087)

Written 2026-08-16. Status: re-foundation complete and verified. Resume here.

## What was done

Axiom re-founded as a hardfork of Hermes Agent (NousResearch/hermes-agent) at
HEAD, per ADR-0087, synthesizing four sources: Hermes (chassis), Prime Agent
(RLM + Continual Harness), DeepSeek Harness (plugin-first), Grok Build (build
discipline + provenance).

- Preserved the prime-agent era: final commit `8c7b408de`, tagged and branched
  `archive/prime-v0.7.2` (nothing lost).
- Repointed remotes: `upstream` → NousResearch/hermes-agent (track),
  `prime-agent` → PrimeIntellect-ai/prime-agent (reference), `upstream-pi`
  unchanged, `origin` → 1deat0r/axiom-agent.
- Reset `main` to Hermes HEAD `0c50bdbde` (2026-08-15) via a shallow fetch.
- Cleaned prime-era untracked leftovers (node_modules, dist, __pycache__,
  plans) — the durable brain was already committed to the archive.
- Carried Axiom's decision layer into `axiom/`: the ADR series (0015–0086),
  ports.md, the agent-process docs, and the sovereign-ts pivot plan.
- Wrote ADR-0087, and rewrote SOUL.md / CONTEXT.md / GUIDE.md for the Hermes
  baseline.

## What was verified (and how)

All verification is repo-state inspection — no code was written this turn, so
no unit tests apply.

- `git status` clean; `main` = Hermes HEAD `0c50bdbde`.
- `git diff --stat upstream/main`: 96 files, 6832 insertions, **all under
  `axiom/`** — the hardfork delta is purely additive; zero Hermes files
  modified.
- `archive/prime-v0.7.2` resolves to `8c7b408de` (prime era intact).
- The pre-commit hook ran clean on the final prime-era commit.

Not verified: booting the Hermes baseline (this host's default python is
3.14, and Hermes pins `>=3.11,<3.14`; a 3.12/3.13 venv is needed). The
working Hermes runtime lives at `~/.hermes/hermes-agent` (separate checkout).

## Next steps (in order)

1. **Unshallow before merging upstream**: `git fetch --unshallow upstream`.
2. **Push decision (operator)**: pushing `main` to origin requires a force
   push (history re-rooted). Not done automatically.
3. **Scaffold the TS sovereign layer** (handoff-sovereign-ts.md §6): package
   home, tsconfig, port `memory.py` → `memory.ts` + tests green.
4. **Path-fix the carried process docs**: axiom/docs/agents/*.md still cite
   `docs/adr/` and the old `upstream` remote; update to `axiom/docs/adr/` and
   the Hermes upstream.
5. **Create `axiom/AGENTS.md`** once the operator approves the
   protected-instruction-file write; the content currently lives in
   `axiom/GUIDE.md`.
6. Open the tracker issue for the re-foundation + first port.
