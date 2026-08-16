# ADR-0092 — Argument coercion extracted from model_tools.py into tool_args.py

Status: accepted
Date: 2026-08-16

## Context

`model_tools.py` mixed three jobs: toolset resolution, single-tool dispatch
(`handle_function_call`), and the argument-coercion cluster — `coerce_tool_args`
plus six helpers (`_coerce_value`, `_coerce_number`, `_coerce_boolean`,
`_coerce_json`, `_schema_allows_null`, `_schema_accepts_kind`,
`_normalize_json_strings_for_schema`) — a pure, registry-backed ~300-line
block with no production consumer other than `handle_function_call` itself.
This was candidate C2 of the 2026-08-16 architecture review: a deep
in-process module with no seam of its own, so its only test surface was
"read the god-file."

The design was grilled with the operator; all frontier decisions
operator-approved.

## Decision

1. **Extract to a new root-level module `tool_args.py`** — a sibling of
   `model_tools.py` (root utility-module precedent), not under `agent/`.
2. **Interface unchanged.** `coerce_tool_args` stays the public name; the
   six helpers keep their names and stay importable — the interface is the
   test surface, and `tests/run_agent/test_tool_arg_coercion.py` already
   treats them as the seam.
3. **No back-compat shims in `model_tools`.** The cluster is underscore-
   private plus one public name whose only consumer is `model_tools`
   itself; shims would be speculative generality. Test imports moved to
   `tool_args`.
4. **Red-first move.** Test imports moved first (red: ModuleNotFoundError),
   then the module created from the verbatim block (green), then the block
   deleted from `model_tools` (322 lines removed).
5. **Dependencies stay cycle-safe leaves:** `tools.registry`
   (`get_schema`), `tools.schema_sanitizer` (`unrename_tool_args`, imported
   lazily as before), stdlib only otherwise.

## Consequences

- `model_tools.py` shrank ~322 lines toward its dispatch job; coercion gets
  locality: its bugs, tests, and changes concentrate in one module.
- `handle_function_call` imports `coerce_tool_args` from `tool_args`; no
  behavior change — the extraction is byte-identical logic.
- Tests: `tests/run_agent/test_tool_arg_coercion.py` and two
  `_coerce_number` inf/nan tests in `tests/test_model_tools.py` now import
  from `tool_args`.
- Upstream-merge posture: `model_tools.py` is upstream-hot; the extraction
  removes a large contiguous region, so future upstream merges that touch
  coercion will conflict — resolve by re-applying upstream's change inside
  `tool_args.py` (the merge ritual's standing rule for seam files).
