# ADR-0091 — One dynamic-schema seam: context-aware dynamic_schema_overrides

Status: accepted
Date: 2026-08-16

## Context

`model_tools._compute_tool_definitions` carried four per-session schema
rewrites hardcoded as name-cases after `registry.get_definitions`:

- **execute_code** — rebuild its schema so the description lists only sandbox
  tools actually available this session (else the model hallucinates
  disabled tools, #560-discord).
- **discord / discord_admin** — rebuild from the bot's privileged intents
  and the user's action allowlist; drop the tool when the probe fails.
- **browser_navigate** — strip the "prefer web_search or web_extract" cross-
  reference when neither web tool is available.
- **browser_exec** — drop the tool when the terminal surface is absent (it
  runs arbitrary Python on the host via the browser-use CLI; a session
  without terminal access must not regain host code execution through the
  browser toolset).

Meanwhile the registry already owned a `dynamic_schema_overrides` seam — used
by delegate_task, image_generation, video_generation, and browser_use_cli for
their config-dependent descriptions — so dynamic schemas had **one seam and
two mechanisms**, with the assembler knowing five tool names (the C8 finding
of the 2026-08-16 architecture review; tracker #69). The cross-tool
conditions are session-scoped, which is why the original code noted check_fn
cannot carry them (check_fn results are TTL-cached process-wide while one
gateway process serves many sessions).

The design was grilled with the operator; all frontier decisions
operator-approved.

## Decision

1. **`dynamic_schema_overrides` becomes context-aware.** The registry resolves
   definitions in two passes: pass 1 applies check_fn filtering and collects
   the candidate name set; pass 2 applies each override, passing the
   `available_tool_names` frozenset to any callable that accepts a parameter
   (signature-inspected per the plugin compat policy — zero-arg callables
   keep the old contract). A dict return merges into the schema; `None`
   drops the tool.
2. **The four rewrites register beside their tools.** execute_code
   (`code_execution_tool.py`), discord/discord_admin (`discord_tool.py`,
   zero-arg callables returning the dynamic schema or None), browser_navigate
   (`browser_tool.py`), browser_exec (`browser_use_cli.py`, returning None
   when terminal is absent). Each owns its static schema and its dynamic
   rules in one file.
3. **`_compute_tool_definitions` knows no tool names.** The four name-cases
   are deleted; the assembler is pure toolset resolution + registry call.
4. **Bridge dispatch is out of scope.** The `tool_search`/`tool_describe`/
   `tool_call` branches in `handle_function_call` are dispatch forks, not
   schema logic; they stay as-is until a dispatch-seam decision justifies
   touching them.

## Consequences

- One mechanism for dynamic schemas: registration beside the tool, applied
  inside the registry. The bridge's `skip_tool_search_assembly` catalog also
  sees corrected schemas, since overrides apply before assembly.
- The memoized `get_tool_definitions` cache still invalidates on registry
  generation + config-mtime fingerprint; nothing about cache correctness
  changed.
- `None`-as-drop is now the registry's contract for every override — a
  behaviour none of the pre-existing overrides used (they return dicts).
- Tests: `tests/run_agent/test_dynamic_schema_seam.py` pins seam A (registry:
  context delivery, partial merge, None-drop, zero-arg compat) and seam B
  (end-to-end through `get_tool_definitions` for execute_code and
  browser_navigate); the pre-existing browser_exec and discord integration
  tests pin the same behaviours through the new mechanism.
- Follow-up surface: any future cross-tool condition registers a
  context-accepting override; no assembler edit needed.
