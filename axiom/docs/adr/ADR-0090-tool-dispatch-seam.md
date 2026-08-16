# ADR-0090 — One tool-dispatch seam: agent executors registered on the registry

Status: accepted
Date: 2026-08-16

## Context

The tool-call story was told three times, with diverging name-forks:

- `model_tools.handle_function_call` — registry dispatch plus bridge forks
  (`tool_search`/`tool_describe`/`tool_call`) and an `execute_code` fork;
  `_AGENT_LOOP_TOOLS = {todo, memory, session_search, delegate_task}`
  hard-stubbed with "must be handled by the agent loop".
- `agent/tool_executor.py execute_tool_calls_sequential` — thirteen inline
  `if/elif` name-forks (todo, session_search, memory, clarify, read_terminal,
  read_preview, read_window_below, setup_mcp, delegate_task, context-engine,
  memory-manager, quiet_mode, else), each reaching into the tool modules'
  implementations with hand-wired args and defaults.
- `agent/agent_runtime_helpers.py invoke_tool` (concurrent path) — the same
  nine-tool intercept chain, but without the sequential path's post-hook
  suppression (an asymmetry that invited double-emit bugs).

All nine agent-level tools were *also* registered in the registry with handler
lambdas reading `store`/`db`/`callback`/`parent_agent` from kwargs that
`registry.dispatch` never supplies — dead-ends through the registry path.
Upstream commit `d083b85591` (2026-08-15) landed a single feature as a
three-way duplicated edit across these pipelines: the tax this decision
eliminates. The design was grilled with the operator (improve-codebase-
architecture run, candidate C1; tracker #68).

## Decision

1. **`ToolEntry` gains an executor contract.** `registry.register(...)`
   accepts `agent_executor(agent, args, ctx) -> result` and
   `after_authorization(agent)`. `ctx` carries exactly
   `{task_id, tool_call_id, session_id, turn_id, api_request_id}`.
2. **Executors live beside their schemas.** Each agent-level tool registers
   its executor in its own tool module, next to its schema and handler —
   the agent-state wiring (todo store, recall DB, callbacks, parent agent)
   lives with the tool it wires.
3. **One resolution point.** Both executor paths resolve
   `registry.dispatch_agent_executor(name, agent, args, ctx)`; no caller
   knows tool names. The plugin seams (context-engine, memory-manager) keep
   their own membership-based contracts and are not part of this seam.
4. **The dead-end stub dies.** `_AGENT_LOOP_TOOLS` and its stub are deleted;
   agent-less callers (MCP tool server, execute_code RPC) degrade uniformly
   through each tool's registry handler, exactly like the other
   callback-injected tools.
5. **Counter resets become entry-level hooks.** `memory` →
   `_turns_since_memory` and `skill_manage` → `_iters_since_skill` register
   `after_authorization` (post-guardrails, pre-execute; a blocked call never
   fires it — timing preserved exactly). The hook currently fires in the
   authorized-dispatch stage (sequential path); the concurrent path never
   reset these counters before this ADR and still does not.
6. **Observability context wraps every dispatch.** The
   `set_current_observability_context` / `reset_current_observability_context`
   pair now wraps the executor paths too, so human-approval prompts fired
   from agent-level tools carry turn/tool/session correlation IDs (previously
   only the `handle_function_call` path set them).
7. **The delegate_task branch keeps display sugar only.** Its spinner and
   label fork remains in the sequential executor for display; execution
   crosses the registry like every other executor.

## Consequences

- One story for "what happens when a tool is called"; adding an agent-level
  tool is one registration, zero forks, zero name lists to keep in sync.
- Defaults now live in the schema alone; the executor forwards the args the
  pipeline already coerced/rewrote.
- Tests: `tests/run_agent/test_tool_dispatch_seam.py` pins the contract
  (executor resolution, ctx shape, block-never-runs, exactly-once post hook,
  uniform agent-less degradation, observability wrap). The fork-structure
  pins in `tests/test_model_tools.py` and `tests/run_agent/test_run_agent.py`
  were rewritten to assert the seam instead.
- Deferred to #69 (ADR-0091): the bridge forks and the `execute_code` fork
  are session-scoping logic that belongs on the `dynamic_schema_overrides`
  seam, not in `handle_function_call` — including a session-aware extension
  for cross-tool conditions (the `browser_exec` gate, whose TTL-cache
  rationale stays documented in `model_tools.py`).
- Upstream risk accepted: the four dispatch files are upstream-hot; the
  change landed as three green commits (tests / refactor / docs) between
  merges — the implementation steps interleaved in shared files, so the
  planned per-step split folded into one refactor commit (recorded in the
  #68 audit comment) — keeping each revertible unit isolated.
