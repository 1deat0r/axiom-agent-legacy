# ADR-0080: /learn — the public on-demand front-end for skill capture

**Status:** accepted
**Date:** 2026-08-15
**Issue:** #54 (ADR-0080 reservation)
**Implements:** ADR-0078 port order step 1
**Extends:** ADR-0024 (capture), ADR-0026 (auto flagging), ADR-0027 (runtime hook)

## Context

The skill-capture pipeline is complete under the hood: ADR-0024 captures a
flagged task into a provenance-bearing, loader-verified skill; ADR-0026 scores
reusability; ADR-0027 runs it unattended (inert unless enabled). What is
missing is the public surface — the way a user asks for a skill right now,
mid-session. The ADR-0078 autonomy direction puts `/learn` first in the port
order and sets the posture: silent by default, no ceremony, the loop writes
only what it owns. This ADR delivers the on-demand command while keeping the
unattended hook inert.

## Decision

1. **`/learn` is an extension command, not a core session command.** The
   skill-capture extension registers `learn` via `pi.registerCommand`
   (the `/cost` pattern), so it inherits the existing command seam: it appears
   in the command menu, executes on the interactive prompt path, and reports
   through `ctx.ui.notify`. It is always available — even when the ADR-0027
   hook is disabled — because silent-by-default governs what the loop does
   unattended, not what the user can ask for.
2. **A new core module `core/skill-capture/learn.ts` front-ends the pipeline:**
   - `parseLearnCommandOptions` accepts nothing or `--force`; anything else is
     a usage error (`Usage: /learn [--force]`).
   - `buildLearnCapture` builds the capture with provenance `source: "learn"`,
     `trigger: "/learn"`, and the session id when the trace carries one.
   - `runLearnCapture` drives evaluate → build → persist → verify and returns a
     discriminated result (`not-flagged` | `invalid` | `exists` | `error` |
     `unverified` | `captured`). Nothing is written when the heuristic rejects
     an unforced capture; the ADR-0024 no-overwrite refusal and the
     real-loader verification are unchanged.
3. **The trace comes from the current session's branch** via the session
   manager (`getBranch()`, which defaults to the leaf) — the persisted truth,
   not the in-flight window. The stored session is the truth (SOUL.md); /learn
   captures what was actually recorded.
4. **Captured skills are staged and offered, not installed.** The capture
   directory is the extension's existing default (`<AXIOM_HOME>/captured-skills`,
   overridable), shared with the ADR-0027 hook. Installing a learned skill into
   a live skills directory is a write the loop must not make silently — that is
   the ownership lattice's job (issue #55, the next capability). The /learn
   report ends with the install instruction.

## Considered and rejected

- **Core session slash command** (a `case "learn"` beside `/goal`/`/autonomous`
  in agent-session): it would reach the live message array directly, but it
  needs the axiom-home semantics for the capture directory default, and those
  live in the profile registry (extension layer). Wiring them into core
  inverts the layering; the extension seam already delivers the full command
  context (`sessionManager`, `ui`).
- **Defaulting the capture dir inside core** (`dirname(getAgentDir())`): wrong
  under profiles (the agent dir *is* the profile home, so its parent is
  `~/.axiom/profiles`, not the profile home). Rejected — one meaning, one
  house.

## Consequences

- The skill-capture extension registers `/learn` with description
  "Capture this session as a reusable skill on demand (/learn [--force])"; the
  interactive command menu picks it up with no further wiring.
- 12 core tests (`skill-capture-learn.test.ts`) + 7 extension command tests
  (`extensions/skill-capture.test.ts`), written red-first: parsing strictness,
  provenance, not-flagged reasoning, `--force`, no-overwrite, session-id
  provenance, and the command being available while the hook is disabled.
- No changes to agent-session or slash-commands core; the delta is the new
  core module, its index exports, and the extension registration.
- The gateway keeps its own command registry; `/learn` is an interactive
  (TUI/daemon) surface, like `/cost` and `/cap`.
