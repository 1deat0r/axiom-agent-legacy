# ADR-0013: Pi v0.84.1 becomes the baseline

**Status:** accepted (owner directive, 2026-08-11)
**Supersedes:** the from-scratch premise of ADR-0012 and the project identity in
SOUL.md ("from-scratch reimagining"); both amend to "pi baseline + axiom capabilities".

## Context

Axiom was built from scratch: a UI-free core (agent loop, sessions, memory,
skills, providers, cost ledger, spend cap) with CLI/TUI/gateway surfaces,
~275 tests and a 100% coverage gate. Its TUI (ADR-0012) hand-rolled a session
view whose reference UX was pi's TUI. The owner directed a major shift:
**the latest Pi Agent becomes the baseline for axiom-agent; axiom then adds
capabilities pi does not have.**

Facts verified 2026-08-11:

- pi is `github.com/earendil-works/pi`, MIT, npm-workspaces monorepo
  (`packages/`: tui, ai, agent, coding-agent, client, protocol, server,
  session-backends, telemetry, evals). Default branch `main`.
- Latest release: **v0.84.1** (2026-08-07); `main` is active (89 commits since
  the tag as of this ADR). npm packages `@earendil-works/{pi-tui,pi-ai,
  pi-agent-core,pi-coding-agent,pi-client,pi-protocol,pi-telemetry,
  pi-storage-sqlite-node}` all 0.84.1, MIT.
- Scale: ~1,100 TS files, ~115k lines (coding-agent 58.7k, ai 22.4k,
  tui 16.2k, agent 12.2k). Full agent surface: differential-rendering TUI with
  editor/overlays/themes, multi-provider AI layer (OpenAI/Anthropic/Google/
  Mistral/Bedrock + model catalog with cost metadata), agent core (loop,
  sessions, tools, compaction, memory, skills), extensions API, RPC
  client/server, sqlite session backend.
- pi HAS: cost display + usage totals (per-model attribution), reasoning
  effort, context compaction, sessions/skills/memory, provider config with a
  custom-provider extension point.
- pi does NOT have: a hard spend cap (axiom `maxRunCostUsd` pre-call guard),
  the per-session/lifetime cost ledger with catalog pricing table + entry
  overrides (ADR-0010/0011), the provider catalog + connect wizard
  (ADR-0009), the messaging gateway with channels and platform transports
  incl. Telegram (ADR-0001/0004/0006), the memory eviction policy
  (ADR-0008).

## Decision

1. **The axiom-agent repo becomes a hard fork of pi v0.84.1** (Axiom's
   fork of pi-mono is the precedent). The pi tree, with its history, is the
   baseline; the fork lives on `baseline/pi-v0.84.1`, and upstream merges are
   routine (`git fetch upstream` + merge).
2. **Axiom's from-scratch tree is preserved on `archive/from-scratch-v0.23`**
   (created from the last from-scratch master, WIP included). Nothing is
   deleted: the ADRs, tests, and differentiators there are the seed corn for
   the port phase.
3. **Axiom capabilities map into two buckets** (full inventory in
   `docs/ports.md`):
   - **Superseded by pi:** the hand-rolled TUI (session-view, frame, markdown,
     palette), line-mode TUI, lossless lineReader, the agent loop, providers,
     sessions, reasoning-effort wiring.
   - **Port onto the baseline** (capabilities pi does not have): the cost
     ledger + spend cap, the provider catalog + connect wizard, the gateway
     (Telegram + channel index), memory eviction, context windowing as a
     complement to pi compaction. Each port is its own tracker issue,
     red-first, on the baseline.
4. **Quality floor:** pi's infra (npm workspaces, vitest, `test.sh` for the
   non-e2e suite, biome, tsgo) is the baseline's floor — it must stay green.
   Axiom's red-first discipline and coverage gate apply to axiom-added code;
   pi's upstream suites keep their upstream expectations.
5. **The ritual survives:** CONTEXT.md vocabulary (amended below), the ADR
   series (0013 continues it; 0001-0012 carried over as the port specs), the
   tracker (GitHub issues), handoff notes.

## Alternatives considered

- **Depend on `@earendil-works/*` npm packages, keep axiom as a thin layer.**
  Rejected: "adding capabilities" requires in-tree changes to the agent loop
  and TUI (the spend cap is a loop guard; the gateway is a new surface); nine
  pinned packages at 0.84.1 is a fork in everything but name, without the
  ability to merge upstream.
- **Rebuild axiom's capabilities as pi extensions only.** Rejected: the
  extensions API covers plugins but not core-loop changes; the gateway is a
  new surface with no extension seam.
- **Keep from-scratch axiom, adopt only pi-tui.** Rejected: that is the old
  ADR-0012 path; the owner directed the whole agent as baseline, not just the
  TUI.

## Consequences

- The port queue (`docs/ports.md`) is the next phase of work, one capability
  per tracker issue, red-first.
- `origin/master` keeps the from-scratch history; the baseline lives on
  `baseline/pi-v0.84.1` until the owner confirms the master re-point (a
  force-push decision).
- The known-broken fullscreen WIP test from the from-scratch era is not fixed;
  it is superseded by pi-tui and preserved on the archive branch for
  archaeology.
