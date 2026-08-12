# ADR-0015: axiom v0.7.2 becomes the baseline

**Status:** accepted (owner directive, 2026-08-12)
**Supersedes:** ADR-0013 (pi v0.84.1 baseline). The from-scratch premise of
ADR-0012 and earlier ADRs remain historical records, not current premises.

## Context

ADR-0013 set pi v0.84.1 as the axiom baseline and axiom shipped four
capabilities pi lacked (extensions): the cost ledger (ADR-0010), the spend cap
(ADR-0011), the memory tool (ADR-0008), and profiles (ADR-0014). Between then
and now, the same author (Mario Zechner) shipped **axiom v0.7.2** (the
project's successor to pi), and the owner directed a complete restart:
**axiom v0.7.2 becomes axiom-agent's base starting point.**

Facts verified 2026-08-12:

- axiom is `github.com/PrimeIntellect-ai/axiom`, MIT, npm-workspaces
  monorepo (`packages/`: tui, ai, agent, coding-agent). Default branch `main`.
- Latest release: **v0.7.2**, tag `83a0f9f`. The `coding-agent` package is the
  agent CLI (config `piConfig.name = "axiom"`, configDir `.axiom/agent`,
  bin `pi` -> `dist/bundle/cli.js`); `agent`/`ai`/`tui` are the pi-suite
  packages at 0.7.2. Core deps ship as R2-hosted tarballs
  (`@earendil-works/{pi-agent-core,pi-ai,pi-tui}` @ the same tag).
- The extension seam axiom ports ride is 1:1 against the pi baseline except:
  `agent_settled` was removed (agent loop end is now `agent_end`), the
  `InlineExtension {name,factory}` wrapper became a bare `ExtensionFactory`,
  `llama.cpp` was removed upstream, and the pi-ai `Usage` dropped `cacheWrite1h`
  (cacheWrite now prices at its own rate; usage is recorded on assistant
  messages only — toolResult/compaction/summary entries no longer carry usage).
  The agent-dir env var renamed `PI_CODING_AGENT_DIR` ->
  `AXIOM_CODING_AGENT_DIR` (`ENV_AGENT_DIR` from config.ts).
- axiom HAS: `/usage` cost+context display (per-session), a `/goal`
  token budget (a token ceiling, not a USD spend cap), the full extensions API
  (before_agent_start, turn_start/turn_end, registerTool/registerCommand,
  `ctx.ui.notify/setStatus`, `ctx.abort`), the daemon-client/daemon-worker
  architecture, RLM heartbeats, recursive subagents, skills + a session-backed
  refinement/harness memory, and per-home agent dirs.
- axiom does NOT have: a lifetime cost ledger with override repricing, a
  hard USD spend cap, a durable user-facing memory tool, or a `--profile`
  multi-identity boot. All four axiom capabilities remain axiom-only.

## Decision

1. **The axiom-agent repo becomes a hard fork of axiom v0.7.2** on
   branch `baseline/prime-v0.7.2`. `upstream` points at
   PrimeIntellect-ai/axiom; upstream merges are routine
   (`git fetch upstream` + merge, per SOUL.md). The old pi remote is kept as
   `upstream-pi` for reference.
2. **Nothing is deleted.** The pi fork line (full pi history + the 12 axiom
   commits) is preserved as `archive/pi-v0.84.1`; the from-scratch tree as
   `archive/from-scratch-v0.23`. The GitHub default branch moves to
   `baseline/prime-v0.7.2` — the restart line.
3. **Axiom capabilities stay axiom-only** and are re-ported onto the v0.7.2
   extension seam as three built-in extensions (`axiom-ledger` carries the
   ledger + spend cap, `axiom-memory`, `axiom-profile`) with the same four
   capabilities (ADR-0010/0011/0008/0014). What axiom now covers
   (per-session cost display, a token budget, skills/refinement for
   agent-learned state) is documented in `docs/ports.md`; the USD cap, lifetime
   ledger, memory tool, and profiles remain the axiom differentiators.
4. **Boot seam:** `--profile <name>` is pre-scanned in `main()` before any
   config resolution, setting `AXIOM_HOME` and `ENV_AGENT_DIR`
   (`AXIOM_CODING_AGENT_DIR`) to the profile home. A decrypt-regression
   test pins the env-var name so a stale var cannot silently unisolate
   profiles (ADR-0014).
5. **Data cutover:** axiom-owned durable data (`~/.axiom/ledger.json`
   overrides/cap and the `~/.axiom/memory/` store) carries over by design —
   `AXIOM_HOME` is baseline-independent. Lifetime spend restarts at zero: the
   ledger derives it from session files in the new agent dir
   (`.axiom/agent`); pi-era sessions are unmigrated and readable on the
   archive branch. No migration code.
6. **Axiom extensions are always-on** built-ins, which makes sessions
   process-local (the baseline daemon-client path is disabled while they
   load). This is the pi-fork behavior carried forward and is a documented
   fork tradeoff, not a defect.

## Consequences

- The fork keeps upstream package names (`@earendil-works/pi-*`); its identity
  is the repo, the root `axiom` bin, and the ritual layer. No package renames.
- Upstream merges continue to be routine; the four extensions ride stable
  extension events so drift surfaces as test failures, not silent breakage.
- `CONTEXT.md`, `SOUL.md`, `AGENTS.md`, and `docs/ports.md` are rewritten for
  the new baseline; ADR-0013's decision text is superseded here.
