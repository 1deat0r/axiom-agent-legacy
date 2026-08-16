# ADR-0093 — Registry generation exposed as a public seam

Status: accepted
Date: 2026-08-16

## Context

The registry's monotonic `_generation` counter is the invalidation signal
for every memoized caller (tool-definitions cache, toolset resolution, token
estimation). Callers reached into the private field instead of crossing an
interface: six read sites (`model_tools.py`, `toolsets.py` ×2,
`agent/tool_executor.py`, `agent/agent_init.py`, `hermes_cli/tools_config.py`)
with `getattr(..., "_generation", 0)` fallbacks that silently decay caches
to 0 on refactor, and one mutation site (`hermes_cli/plugin_dev.py`) that
popped/restored `registry._tools` and bumped the counter by hand. Two more
staleness leaks shared the root cause: `restore_registration` (the public
per-name restore) did not bump the generation at all, and
`model_tools.TOOL_TO_TOOLSET_MAP` / `TOOLSET_REQUIREMENTS` were frozen
import-time snapshots that went stale after MCP refresh or plugin (un)load.
This was candidate C9 of the 2026-08-16 architecture review.

The design was approved by the operator in the report phase.

## Decision

1. **`ToolRegistry.generation()` is the public read** — lock-protected,
   documented as the memo key every cache invalidates against.
2. **All read sites re-point to `generation()`** — including the seventh,
   `tools/mcp_tool.py`'s publish-generation snapshot (found by the review
   axis after the first write) — inside their existing defensive try/except
   blocks, preserving fallback semantics.
3. **`restore_registration`'s bump stays exactly once, inside the lock.**
   The first version of this ADR claimed the restore lacked a bump — the
   premise was wrong (the upstream merge that landed just before this work
   had already added one), and the initial fix added a duplicate bump
   outside the lock. Corrected: the in-lock bump is the single mutation;
   the review's exact-delta test pins one bump per restore.
4. **`restore_global_slots(previous)` is the plugin-dev teardown seam** — the
   host's bulk restore semantics (each changed name returns to its prior
   entry; absent → removed; one bump) are a different contract from the
   identity-checked per-name restore, so the registry grew a second honest
   method rather than the caller mutating `_tools`. The plugin ownership
   policy ledger (`_plugin_override_policy`) still has no public restore API
   and remains the one private field the host touches — a documented
   follow-up, not a justification for more raw access.
5. **`TOOL_TO_TOOLSET_MAP` / `TOOLSET_REQUIREMENTS` become live snapshots** —
   resolved from the registry on every access via module `__getattr__`, so
   the `from model_tools import ...` surface is unchanged but never stale.

## Consequences

- Registry internals stay private: no caller reads `_generation` or writes
  `_tools` outside the registry anymore.
- `model_tools`'s backward-compat constants now allocate per access; the
  consumers (batch_runner, cli, doctor) read them rarely, and doctor's tests
  patch them as before (patching sets a real attribute, shadowing
  `__getattr__` for the patch's lifetime).
- Tests: `tests/tools/test_registry_generation.py` (3, red first) pins the
  public read, the restore bump, and the live snapshots.
- Follow-up (recorded): a public API for the plugin-override policy ledger.
