"""Tool argument type coercion (ADR-0092).

Extracted from model_tools.py. ``coerce_tool_args`` compares each tool-call
argument against the tool's registered JSON Schema and safely coerces
string-typed values (numbers, booleans, JSON-encoded containers), wraps bare
scalars into single-element arrays, and renames sanitized property keys back
to their schema names. Pure, registry-backed plumbing — the interface is the
test surface (tests/run_agent/test_tool_arg_coercion.py).

Dependencies are cycle-safe leaves: tools.registry, tools.schema_sanitizer.
"""
import json
import logging
from typing import Any, Dict, Union

from tools.registry import registry

logger = logging.getLogger(__name__)


def coerce_tool_args(tool_name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Coerce tool call arguments to match their JSON Schema types.

    LLMs frequently return numbers as strings (``"42"`` instead of ``42``)
    and booleans as strings (``"true"`` instead of ``true``).  This compares
    each argument value against the tool's registered JSON Schema and attempts
    safe coercion when the value is a string but the schema expects a different
    type.  Original values are preserved when coercion fails.

    Handles ``"type": "integer"``, ``"type": "number"``, ``"type": "boolean"``,
    and union types (``"type": ["integer", "string"]``).

    Also wraps bare scalar values in a single-element list when the schema
    declares ``"type": "array"``.  Open-weight models (DeepSeek, Qwen, GLM)
    sometimes emit ``{"urls": "https://a.com"}`` when the tool expects
    ``{"urls": ["https://a.com"]}``; wrapping here avoids a confusing tool
    failure on what is otherwise a well-formed call.
    """
    if not args or not isinstance(args, dict):
        return args

    schema = registry.get_schema(tool_name)
    if not schema:
        return args

    properties = (schema.get("parameters") or {}).get("properties")
    if not properties:
        return args

    # The model saw the SANITIZED schema — property keys violating provider
    # patterns (e.g. Cloudflare's ``issue_class~neq``) were renamed before
    # the request. Map any sanitized keys back to the registry's original
    # wire names before schema lookup / dispatch.
    try:
        from tools.schema_sanitizer import unrename_tool_args
        args = unrename_tool_args(schema.get("parameters"), args)
    except Exception:  # pragma: no cover — never break dispatch
        pass

    for key, value in list(args.items()):
        prop_schema = properties.get(key)
        if not prop_schema:
            continue
        expected = prop_schema.get("type")

        # Wrap bare non-list values when the schema declares ``array``.
        # Strings still go through _coerce_value first so JSON-encoded
        # arrays (``'["a","b"]'``) get parsed and nullable ``"null"``
        # becomes ``None`` rather than ``["null"]``.
        # ``None`` itself is preserved — we don't know whether the model
        # meant "omit" or "empty list", and tools with sensible defaults
        # (e.g. read_file's normalize_read_pagination) already handle it.
        if expected == "array" and value is not None and not isinstance(value, (list, tuple)):
            if isinstance(value, str):
                coerced = _coerce_value(value, expected, schema=prop_schema)
                if coerced is not value:
                    # _coerce_value handled it (JSON-parsed list or
                    # nullable "null" → None).
                    args[key] = coerced
                    continue
                # If the string looks like a JSON array but _coerce_value
                # failed to parse it, warn clearly instead of silently wrapping.
                if value.strip().startswith("["):
                    logger.warning(
                        "coerce_tool_args: %s.%s looks like a JSON array string "
                        "but could not be parsed — model may have emitted a "
                        "JSON-encoded string instead of a native array. "
                        "Falling back to single-element list.",
                        tool_name, key,
                    )
                args[key] = [value]
                logger.info(
                    "coerce_tool_args: wrapped bare string in list for %s.%s",
                    tool_name, key,
                )
                continue
            args[key] = [value]
            logger.info(
                "coerce_tool_args: wrapped bare %s in list for %s.%s",
                type(value).__name__, tool_name, key,
            )
            continue

        if not isinstance(value, str):
            # Recurse into already-native containers so JSON-encoded
            # *elements* (array items) and *sub-fields* (nested object
            # properties) get normalized too — e.g. ``todos: ['{"id":...}']``
            # or ``tasks: [{"goal": "..."}]`` where an element was emitted as
            # a JSON string. The top-level coercion above only repairs the
            # outermost value.
            if expected == "array" and isinstance(value, (list, tuple)):
                args[key] = _normalize_json_strings_for_schema(value, prop_schema)
            elif expected == "object" and isinstance(value, dict):
                args[key] = _normalize_json_strings_for_schema(value, prop_schema)
            continue
        if not expected and not _schema_allows_null(prop_schema):
            continue
        coerced = _coerce_value(value, expected, schema=prop_schema)
        if coerced is not value:
            args[key] = coerced
            # If we just JSON-parsed a string into a container, recurse so
            # nested JSON-encoded elements/fields get normalized as well.
            if isinstance(coerced, (list, tuple, dict)):
                args[key] = _normalize_json_strings_for_schema(coerced, prop_schema)

    return args


def _schema_accepts_kind(schema: Any, kind: str) -> bool:
    """Return True when *schema* permits a value of JSON type *kind*.

    Looks at ``type`` (string or list) and recurses through
    ``anyOf``/``oneOf``/``allOf`` branches — matching the JSON-Schema shapes
    open-weight models emit against. ``kind`` is ``"array"`` or ``"object"``.
    """
    if not isinstance(schema, dict):
        return False
    t = schema.get("type")
    if t == kind or (isinstance(t, list) and kind in t):
        return True
    for union_key in ("anyOf", "oneOf", "allOf"):
        branches = schema.get(union_key)
        if isinstance(branches, list) and any(
            _schema_accepts_kind(b, kind) for b in branches
        ):
            return True
    return False


def _normalize_json_strings_for_schema(value: Any, schema: Any) -> Any:
    """Recursively parse JSON-encoded string values that a schema expects to
    be arrays or objects, including nested array items and object properties.

    Open-weight models (DeepSeek, Qwen, GLM, and others) sometimes emit a
    structured field — or an *element* of a structured field — as a
    JSON-encoded string instead of a native value. The top-level
    :func:`coerce_tool_args` pass repairs the outermost value; this helper
    walks the rest of the tree so cases like::

        {"todos": ["{\\"id\\": \\"1\\", \\"content\\": \\"x\\"}"]}

    (a list whose elements are JSON strings) and nested object sub-fields are
    repaired too. Parsing is schema-guided: a string is only parsed when the
    matching schema position actually expects an array or object, so
    legitimate JSON-looking string fields (``type: string``) are preserved.

    Ported from cline/cline#11803, adapted to hermes-agent's coercion layer.
    Returns the original value object when nothing changed (identity preserved
    so callers can cheaply detect no-ops).
    """
    if not isinstance(schema, dict):
        return value

    # Parse a JSON-encoded string into the container the schema expects.
    if isinstance(value, str):
        trimmed = value.strip()
        expects_array = _schema_accepts_kind(schema, "array")
        expects_object = _schema_accepts_kind(schema, "object")
        if (expects_array and trimmed.startswith("[")) or (
            expects_object and trimmed.startswith("{")
        ):
            try:
                parsed = json.loads(trimmed)
            except (ValueError, TypeError):
                return value
            if isinstance(parsed, list) and expects_array:
                value = parsed
            elif isinstance(parsed, dict) and expects_object:
                value = parsed
            else:
                return value
        else:
            return value

    # Recurse into list items using the ``items`` schema.
    if isinstance(value, list):
        items_schema = schema.get("items")
        if not isinstance(items_schema, dict):
            return value
        changed = False
        out = []
        for item in value:
            nxt = _normalize_json_strings_for_schema(item, items_schema)
            changed = changed or (nxt is not item)
            out.append(nxt)
        return out if changed else value

    # Recurse into object properties using each property's schema.
    if isinstance(value, dict):
        props = schema.get("properties")
        if not isinstance(props, dict):
            return value
        changed = False
        out = dict(value)
        for k, prop_schema in props.items():
            if k not in value or not isinstance(prop_schema, dict):
                continue
            nxt = _normalize_json_strings_for_schema(value[k], prop_schema)
            if nxt is not value[k]:
                out[k] = nxt
                changed = True
        return out if changed else value

    return value


def _coerce_value(value: str, expected_type, schema: dict | None = None):
    """Attempt to coerce a string *value* to *expected_type*.

    Returns the original string when coercion is not applicable or fails.
    """
    if _schema_allows_null(schema) and value.strip().lower() == "null":
        return None

    if isinstance(expected_type, list):
        # Union type — try each in order, return first successful coercion
        for t in expected_type:
            result = _coerce_value(value, t, schema=schema)
            if result is not value:
                return result
        return value

    if expected_type in {"integer", "number"}:
        return _coerce_number(value, integer_only=(expected_type == "integer"))
    if expected_type == "boolean":
        return _coerce_boolean(value)
    if expected_type == "array":
        return _coerce_json(value, list)
    if expected_type == "object":
        return _coerce_json(value, dict)
    if expected_type == "null" and value.strip().lower() == "null":
        return None
    return value


def _schema_allows_null(schema: dict | None) -> bool:
    """Return True when a JSON Schema fragment explicitly permits null."""
    if not isinstance(schema, dict):
        return False

    schema_type = schema.get("type")
    if schema_type == "null":
        return True
    if isinstance(schema_type, list) and "null" in schema_type:
        return True
    if schema.get("nullable") is True:
        return True

    for union_key in ("anyOf", "oneOf"):
        variants = schema.get(union_key)
        if not isinstance(variants, list):
            continue
        for variant in variants:
            if isinstance(variant, dict) and variant.get("type") == "null":
                return True

    return False


def _coerce_json(value: str, expected_python_type: type):
    """Parse *value* as JSON when the schema expects an array or object.

    Handles model output drift where a complex oneOf/discriminated-union schema
    causes the LLM to emit the array/object as a JSON string instead of a native
    structure.  Returns the original string if parsing fails or yields the wrong
    Python type.
    """
    try:
        parsed = json.loads(value)
    except (ValueError, TypeError) as exc:
        logger.warning(
            "coerce_tool_args: failed to parse string as JSON for expected type %s: %s",
            expected_python_type.__name__,
            exc,
        )
        return value
    if isinstance(parsed, expected_python_type):
        logger.debug(
            "coerce_tool_args: coerced string to %s via json.loads",
            expected_python_type.__name__,
        )
        return parsed
    logger.warning(
        "coerce_tool_args: JSON-parsed value is %s, expected %s — skipping coercion",
        type(parsed).__name__,
        expected_python_type.__name__,
    )
    return value


def _coerce_number(value: str, integer_only: bool = False):
    """Try to parse *value* as a number.  Returns original string on failure."""
    try:
        f = float(value)
    except (ValueError, OverflowError):
        return value
    # Guard against inf/nan — not JSON-serializable, keep original string
    if f != f or f == float("inf") or f == float("-inf"):
        return value
    # If it looks like an integer (no fractional part), return int
    if f == int(f):
        return int(f)
    if integer_only:
        # Schema wants an integer but value has decimals — keep as string
        return value
    return f


def _coerce_boolean(value: str):
    """Try to parse *value* as a boolean.  Returns original string on failure."""
    low = value.strip().lower()
    if low == "true":
        return True
    if low == "false":
        return False
    return value


