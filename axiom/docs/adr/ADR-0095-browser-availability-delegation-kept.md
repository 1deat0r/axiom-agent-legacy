# ADR-0095 — Browser availability probes: delegation chain kept; C4 consolidation declined

Status: accepted
Date: 2026-08-16

## Context

Candidate C4 of the architecture review (2026-08-16) proposed consolidating
the browser availability probes — then six probes across five modules
(check_browser_requirements, check_browser_vision_requirements,
_browser_cdp_check, _browser_dialog_check, check_camofox_available,
is_browser_use_cli_mode) — into one browser-availability module, on the
grounds that six probes told one story with duplicated logic.

The design was taken through the grill-with-docs round, and the
fact-finding overturned the premise: the upstream merge that landed before
this session already built the delegation chain, and the remaining probes
each carry distinct logic. Per the repo's own rubric — verify the premise
against the codebase before building — the consolidation is declined and
the decision recorded instead of code being written.

## Evidence (current tree)

1. **The delegation chain already exists.**
   `_browser_dialog_check` → `_browser_cdp_check` (browser_dialog_tool.py)
   → `check_browser_requirements` (browser_cdp_tool.py);
   `check_browser_vision_requirements` → `check_browser_requirements`;
   `check_browser_requirements` gates on `is_browser_use_cli_mode` first.
   "One availability story" is now expressed through delegation, not
   duplication.
2. **The two CLI finders are different contracts, not copies.**
   `browser_use_cli._find_cli` is managed-first with a uvx fallback;
   `browser_tool._find_agent_browser` validates candidates (dangling-link
   guard, #48521), searches an extended PATH (Homebrew, Termux), and falls
   back to npx. Unifying them would either over-abstract (speculative
   generality) or change resolution behavior.
3. **The remaining probes are unique logic.** Camofox does an HTTP health
   probe + VNC port discovery; the CDP check gates on a configured
   `BROWSER_CDP_URL`; the built-in check branches over Cloud/Lightpanda/
   Chromium/Termux. Deletion test: consolidating would move complexity,
   not concentrate it.
4. **A single module would import-cycle.** The probes' dependencies
   (browser_tool ↔ browser_use_cli ↔ browser_camofox) are already resolved
   by lazy in-function imports; a shared availability module would need
   those imports in the reverse direction.

## Decision

1. **C4 consolidation is declined** — the six probes stay where they are,
   with their existing delegation chain. No code change.
2. **The injectable-probe-registry idea is deferred** (documented
   follow-up, not a ticket): today's probes are unit-testable by
   monkeypatching their primitives; an injectable seam on the registry is
   only justified when a second real adapter for probe injection appears.
3. **The architecture-review report's C4 card is superseded by this ADR.**

## Consequences

- No new module, no cycle risk, no behavior change; the review's remaining
  candidates (C5, C6, C7, C10) are unaffected.
- Future availability work: extend the existing delegation chain; do not
  re-propose a browser-availability mega-module without evidence that the
  delegation chain has broken down.
