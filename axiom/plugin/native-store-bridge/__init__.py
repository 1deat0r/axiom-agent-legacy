"""native-store-bridge — mirror Hermes memory + skill writes into Axiom's native stores.

A ``post_tool_call`` observer. Every time the ``memory`` or ``skill_manage``
tool performs a successful write, this plugin replays the same operation
against the matching native store under ``axiom/sovereign/data/``:

- ``memory``       -> ``data/memory.json``  (facts; canonical, profile is a projection)
- ``skill_manage`` -> ``data/skills.json``  (skill lineage; store canonical over SKILL.md)

so the stores stay the auditable record of Axiom's own evolution and the
profile remains a derived / operational view.

This is the store-first half of Axiom's sovereign layer (port #3, issue #64):
the same logic as 3V0's ``3v0/plugin/native-store-bridge``, re-pointed at the
TypeScript sovereign CLI (``node axiom/sovereign/src/cli/*.ts``) instead of
3V0's Python scripts. It is best-effort by construction: any failure is
swallowed and the wake-time reconcilers ``sync --write`` (memory) and
``sync_skills --write`` (skills) are the backstop.

The write mirror is scoped to Axiom's own sessions: the ``post_tool_call``
payload carries the writing agent's ``session_id``, and the mirror refuses to
replay when that session's recorded ``cwd`` (from the profile's ``state.db``)
is a sibling project rather than Axiom's repo or ``AXIOM_HOME``. An
unknown/empty ``session_id`` or a missing ``cwd`` column fails open (the
primary project), so the mirror never blocks a legitimate Axiom write.

The same plugin also registers two first-class tools over the native stores:

- ``axiom_store`` — the read half: a read-only query tool that shells out to
  ``src/cli/query.ts`` and returns the store's canonical view (supersession
  history and curator states) the derived profile projection hides.
- ``axiom_record`` — the write half: a store-first decision actuator over BOTH
  native stores. Memory actions shell out to ``src/cli/record.ts`` (record a
  fact, optionally superseding an old one, or retract one by id); skill actions
  shell out to ``src/cli/record_skills.ts`` (``skill_update`` /
  ``skill_retract`` / ``skill_absorb``). Each re-exports the profile projection
  (MEMORY.md / the SKILL.md) after the write. Unlike the best-effort write
  *mirror* above, this is a direct actuator — a refusal surfaces as a JSON
  error the agent can see and correct.

Out of scope for this port: 3V0's own-clock session-end reviewer
(``review_session.py``) stays Python/3V0 and is not wired here.

No runtime core files are edited. The plugin ships under ``axiom/plugin/`` in
the repo and is copied into the Axiom Hermes profile's ``plugins/`` dir.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_NODE = "node"

_warned_missing_root = False
_warned_missing_memory_ingest = False
_warned_missing_skill_ingest = False


def _profile_home() -> Path:
    """The active profile's home (HERMES_HOME), or the Axiom profile path."""
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env)
    return Path.home() / ".hermes" / "profiles" / "axiom"


def _axiom_home() -> Path:
    """Axiom's own durable-state home (AXIOM_HOME, default ~/.axiom)."""
    env = os.environ.get("AXIOM_HOME")
    return Path(env).expanduser() if env else Path.home() / ".axiom"


def _resolve_sovereign_root() -> Optional[Path]:
    """Locate the TS sovereign package (source of the store CLIs + data dir)."""
    # 1. Explicit env override.
    env = os.environ.get("AXIOM_SOVEREIGN_ROOT")
    if env:
        p = Path(env).expanduser()
        if (p / "src" / "cli").is_dir():
            return p
    # 2. Marker file written at setup (durable across sessions, for deployed
    #    profile copies that no longer sit in the repo tree).
    marker = _profile_home() / "axiom_sovereign_root"
    try:
        if marker.exists():
            p = Path(marker.read_text(encoding="utf-8").strip()).expanduser()
            if (p / "src" / "cli").is_dir():
                return p
    except OSError:
        pass
    # 3. Repo-relative: this plugin lives at axiom/plugin/native-store-bridge/,
    #    so axiom/sovereign/ is two levels up.
    here = Path(__file__).resolve().parent
    p = here.parents[1] / "sovereign"
    if (p / "src" / "cli").is_dir():
        return p
    # 4. Default (operator home checkout).
    p = Path.home() / "Projects" / "axiom-agent" / "axiom" / "sovereign"
    return p if (p / "src" / "cli").is_dir() else None


def _subprocess_env(sovereign_root: Path) -> Dict[str, str]:
    """Build the subprocess env, setting the AXIOM_* path overrides the CLIs
    resolve. Existing env values win (``setdefault``), so tests and operators
    can redirect the store without editing the plugin."""
    env = os.environ.copy()
    env.setdefault("AXIOM_STORE", str(sovereign_root / "data" / "memory.json"))
    env.setdefault("AXIOM_SKILL_STORE", str(sovereign_root / "data" / "skills.json"))
    env.setdefault("AXIOM_PROFILE_MEM", str(_profile_home() / "memories"))
    env.setdefault("AXIOM_SKILLS_DIR", str(_profile_home() / "skills"))
    return env


def _node_cli(sovereign_root: Path, name: str) -> Path:
    return sovereign_root / "src" / "cli" / f"{name}.ts"


def _write_origin() -> str:
    """The active write origin: 'background_review' on the fork, else
    'assistant_tool' (the foreground agent's origin)."""
    try:
        from tools.skill_provenance import get_current_write_origin

        return get_current_write_origin()
    except Exception:
        return "assistant_tool"


def _result_ok(result: Any) -> bool:
    """True when the tool reported a successful write (JSON with success:true)."""
    data: Any = result
    if isinstance(result, str):
        try:
            data = json.loads(result)
        except json.JSONDecodeError:
            return False
    return isinstance(data, dict) and bool(data.get("success"))


def _run_ingest(sovereign_root: Path, cli_name: str, payload: dict) -> None:
    """Run an ingest CLI as a best-effort subprocess; swallow every failure."""
    try:
        subprocess.run(
            [_NODE, str(_node_cli(sovereign_root, cli_name))],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=30,
            env=_subprocess_env(sovereign_root),
        )
    except Exception as e:  # noqa: BLE001 - best-effort observer
        logger.debug("native-store-bridge ingest failed: %s", e)


# ---------------------------------------------------------------------------
# Session scoping — only Axiom's own sessions mirror into the stores
# ---------------------------------------------------------------------------

def _state_db() -> Path:
    """The active profile's session DB (the same state.db the reviewer reads)."""
    return _profile_home() / "state.db"


def _session_cwd(session_id: str) -> Optional[str]:
    """The recorded cwd for a session row, or None (fail-open).

    Column-aware: a missing DB, a missing row, or a missing ``cwd`` column all
    return None so the gate treats the write as Axiom's own (the primary
    project). Best-effort by construction — a failed lookup must never block a
    legitimate mirror.
    """
    if not session_id:
        return None
    db = _state_db()
    if not db.exists():
        return None
    try:
        conn = sqlite3.connect(str(db), timeout=5)
        try:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
            if "cwd" not in cols:
                return None
            row = conn.execute(
                "SELECT cwd FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    if row is None:
        return None
    return row[0] or None


def _is_axiom_cwd(cwd: Optional[str], repo_root: Path) -> bool:
    """True when a cwd is Axiom's own (its repo, a subdir, AXIOM_HOME, or $HOME).

    Sibling projects (F1NANCE, 3V0) that share this profile's state.db must not
    be folded into Axiom's stores. An unknown/empty cwd is treated as Axiom (the
    primary project) — fail-open.
    """
    if not cwd:
        return True
    cwd = str(cwd)
    root = str(repo_root).rstrip("/")
    return (
        cwd == root
        or cwd.startswith(root + "/")
        or cwd == str(Path.home())
        or cwd == str(_axiom_home())
    )


def _session_is_axiom(session_id: str, repo_root: Path) -> bool:
    """True when a write's session belongs to Axiom (or is unscoped — fail-open)."""
    if not session_id:
        return True
    return _is_axiom_cwd(_session_cwd(session_id), repo_root)


# ---------------------------------------------------------------------------
# memory -> store
# ---------------------------------------------------------------------------

def _ops_from_args(args: Dict[str, Any]) -> Optional[list]:
    """Extract the memory-tool operations (single-op or batch) from the args."""
    target = args.get("target") or "memory"
    if target not in {"memory", "user"}:
        return None

    ops = args.get("operations")
    if isinstance(ops, list) and ops:
        return [
            {
                "action": (op or {}).get("action"),
                "content": (op or {}).get("content"),
                "old_text": (op or {}).get("old_text"),
            }
            for op in ops
            if isinstance(op, dict)
        ]

    action = args.get("action")
    if action not in {"add", "replace", "remove"}:
        return None
    return [{
        "action": action,
        "content": args.get("content"),
        "old_text": args.get("old_text"),
    }]


def _mirror_memory(args: Dict[str, Any], result: Any, session_id: str = "") -> None:
    global _warned_missing_root, _warned_missing_memory_ingest

    if not isinstance(args, dict):
        return
    if not _result_ok(result):
        return

    target = args.get("target") or "memory"
    if target not in {"memory", "user"}:
        return
    ops = _ops_from_args(args)
    if not ops:
        return

    root = _resolve_sovereign_root()
    if root is None:
        if not _warned_missing_root:
            _warned_missing_root = True
            logger.warning(
                "native-store-bridge: cannot locate the Axiom sovereign package "
                "(set AXIOM_SOVEREIGN_ROOT or write %s) — writes will not be "
                "mirrored to the stores; wake sync remains the backstop",
                _profile_home() / "axiom_sovereign_root",
            )
        return
    if not _session_is_axiom(session_id, root.parents[1]):
        logger.debug(
            "native-store-bridge: skipping memory mirror — session %s is not "
            "Axiom's own cwd",
            session_id,
        )
        return

    cli = _node_cli(root, "ingest")
    if not cli.exists():
        if not _warned_missing_memory_ingest:
            _warned_missing_memory_ingest = True
            logger.warning(
                "native-store-bridge: ingest.ts not found at %s — memory writes "
                "will not be mirrored to the store",
                cli,
            )
        return

    _run_ingest(root, "ingest", {"target": target, "source": _write_origin(), "ops": ops})


# ---------------------------------------------------------------------------
# skill_manage -> skill store
# ---------------------------------------------------------------------------

def _mirror_skill(args: Dict[str, Any], result: Any, session_id: str = "") -> None:
    global _warned_missing_root, _warned_missing_skill_ingest

    if not isinstance(args, dict):
        return
    if not _result_ok(result):
        return
    name = (args.get("name") or "").strip()
    if not name:
        return

    root = _resolve_sovereign_root()
    if root is None:
        if not _warned_missing_root:
            _warned_missing_root = True
            logger.warning(
                "native-store-bridge: cannot locate the Axiom sovereign package "
                "(set AXIOM_SOVEREIGN_ROOT or write %s) — writes will not be "
                "mirrored to the stores; wake sync remains the backstop",
                _profile_home() / "axiom_sovereign_root",
            )
        return
    if not _session_is_axiom(session_id, root.parents[1]):
        logger.debug(
            "native-store-bridge: skipping skill mirror — session %s is not "
            "Axiom's own cwd",
            session_id,
        )
        return

    cli = _node_cli(root, "ingest_skills")
    if not cli.exists():
        if not _warned_missing_skill_ingest:
            _warned_missing_skill_ingest = True
            logger.warning(
                "native-store-bridge: ingest_skills.ts not found at %s — skill "
                "writes will not be mirrored to the store",
                cli,
            )
        return

    _run_ingest(root, "ingest_skills", {"source": _write_origin(), "args": args})


def _on_post_tool_call(
    tool_name: str = "",
    args: Optional[Dict[str, Any]] = None,
    result: Any = None,
    session_id: str = "",
    **_: Any,
) -> None:
    if tool_name == "memory":
        _mirror_memory(args or {}, result, session_id=session_id)
    elif tool_name == "skill_manage":
        _mirror_skill(args or {}, result, session_id=session_id)


# ---------------------------------------------------------------------------
# axiom_store — read-only query tool over the native stores
# ---------------------------------------------------------------------------

_AXIOM_STORE_SCHEMA = {
    "name": "axiom_store",
    "description": (
        "Read Axiom's native stores — the canonical, lineage-bearing record of "
        "Axiom's own memory and skill evolution, not the derived profile "
        "projection. Use it to see what was superseded and what replaced it "
        "(memory facts carry provenance + supersession history; skills carry "
        "version lineage + curator active/stale/archived state). Read-only."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["summary", "facts", "fact_history", "skills", "skill_history"],
                "description": (
                    "summary: overview of both stores. facts: active facts "
                    "(optionally filter by kind). fact_history: full "
                    "supersession lineage of one fact (needs fact_id). "
                    "skills: active skills with version, source, and curator "
                    "state (optionally filter by name). skill_history: full "
                    "version lineage of one skill (needs name)."
                ),
            },
            "kind": {
                "type": "string",
                "enum": ["memory", "user", "identity", "directive"],
                "description": "With action='facts': restrict to this fact kind.",
            },
            "fact_id": {
                "type": "string",
                "description": "With action='fact_history': the fact id to trace.",
            },
            "name": {
                "type": "string",
                "description": (
                    "With action='skill_history' (required) or 'skills' "
                    "(optional filter): the skill name."
                ),
            },
        },
        "required": ["action"],
    },
}


def _handle_store_query(args=None, **_) -> str:
    """Serve a read query by shelling out to src/cli/query.ts (JSON out).

    Unlike the write mirror (best-effort, failures swallowed), a read MUST
    return a useful result to the agent, so failures surface as a JSON error
    object rather than being dropped silently.
    """
    root = _resolve_sovereign_root()
    if root is None:
        return json.dumps({
            "error": (
                "Axiom sovereign package not found — cannot read the native "
                "stores. Set AXIOM_SOVEREIGN_ROOT or write the root marker."
            ),
        })

    query = _node_cli(root, "query")
    if not query.exists():
        return json.dumps({"error": f"query.ts not found at {query}"})

    a = args or {}
    argv = [_NODE, str(query), "--action", str(a.get("action", ""))]
    if a.get("kind"):
        argv += ["--kind", str(a["kind"])]
    if a.get("fact_id"):
        argv += ["--fact-id", str(a["fact_id"])]
    if a.get("name"):
        argv += ["--name", str(a["name"])]

    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=30, env=_subprocess_env(root)
        )
    except Exception as e:  # noqa: BLE001 - read path must still return something
        return json.dumps({"error": f"store query failed: {e}"})

    if proc.returncode != 0:
        return json.dumps({
            "error": "store query error",
            "stderr": (proc.stderr or "").strip(),
        })
    return proc.stdout or "{}"


# ---------------------------------------------------------------------------
# axiom_record — store-first write tool over the native stores
# ---------------------------------------------------------------------------

_AXIOM_RECORD_SCHEMA = {
    "name": "axiom_record",
    "description": (
        "Write to Axiom's native stores — the store-first decision actuator "
        "(the write half of Axiom's own evolution loop). Memory: record a new "
        "fact, optionally superseding an old one (flagged and recoverable, "
        "never erased), or retract one by id. Skills: replace a skill's full "
        "SKILL.md (skill_update), decommission it with no successor "
        "(skill_retract), or fold it into an umbrella (skill_absorb). The "
        "store is the canonical origin; the Hermes profile (MEMORY.md/"
        "USER.md, or the SKILL.md) is re-exported as a derived view after "
        "the write. Use axiom_store to read the store first (e.g. to find "
        "a fact_id to supersede, or a skill name to decommission). "
        "Corrections go here, not through the Hermes memory/skill_manage "
        "tools, so supersession is recorded instead of silently overwritten."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["record", "retract", "skill_update", "skill_retract", "skill_absorb"],
                "description": (
                    "record: add a fact, optionally superseding an old one. "
                    "retract: remove an active fact by id (recoverable, no "
                    "successor). skill_update: replace a skill's full "
                    "SKILL.md (superseding the active version). "
                    "skill_retract: decommission a skill with no successor. "
                    "skill_absorb: fold a skill into an umbrella (via "
                    "absorbed_into)."
                ),
            },
            "kind": {
                "type": "string",
                "enum": ["memory", "user", "identity", "directive"],
                "description": (
                    "With action='record' (required): the fact's kind. "
                    "identity/directive are store-only (not projected to the "
                    "profile)."
                ),
            },
            "content": {
                "type": "string",
                "description": (
                    "With action='record' (required): the new fact text. "
                    "With action='skill_update' (required): the full "
                    "replacement SKILL.md."
                ),
            },
            "fact_id": {
                "type": "string",
                "description": (
                    "With action='retract' (required): the fact id to remove. "
                    "With action='record' (optional): supersede the fact with "
                    "this exact id."
                ),
            },
            "supersedes": {
                "type": "string",
                "description": (
                    "With action='record' (optional): supersede the active "
                    "fact whose content contains this substring (must match "
                    "exactly one)."
                ),
            },
            "name": {
                "type": "string",
                "description": (
                    "With skill actions (required): the skill name (as shown "
                    "by axiom_store action='skills')."
                ),
            },
            "category": {
                "type": "string",
                "description": (
                    "With action='skill_update' (optional): category subdir "
                    "for a NEW skill (ignored when the skill already exists)."
                ),
            },
            "absorbed_into": {
                "type": "string",
                "description": (
                    "With action='skill_absorb' (required): the umbrella "
                    "skill that absorbs this one (must already exist)."
                ),
            },
            "source": {
                "type": "string",
                "description": "Optional provenance label (default 'foreground').",
            },
        },
        "required": ["action"],
    },
}


def _handle_store_record(args=None, **_) -> str:
    """Serve a store-first write by shelling out to src/cli/record.ts (JSON).

    Unlike the best-effort write mirror (post_tool_call, failures swallowed),
    this is a direct actuator: the agent asked to write, so a refusal or a
    failed subprocess surfaces as a JSON error object it can see and correct.
    """
    root = _resolve_sovereign_root()
    if root is None:
        return json.dumps({
            "error": (
                "Axiom sovereign package not found — cannot write the native "
                "store. Set AXIOM_SOVEREIGN_ROOT or write the root marker."
            ),
        })

    script = _node_cli(root, "record")
    if not script.exists():
        return json.dumps({"error": f"record.ts not found at {script}"})

    a = args or {}
    action = str(a.get("action", "")).strip()
    if action in {"skill_update", "skill_retract", "skill_absorb"}:
        return _handle_skill_record(a)
    if action not in {"record", "retract"}:
        return json.dumps({"error": f"unknown action {action!r}"})

    argv = [_NODE, str(script), "--json", "--write"]
    if action == "retract":
        fact_id = str(a.get("fact_id", "")).strip()
        if not fact_id:
            return json.dumps({"error": "fact_id is required for action='retract'"})
        argv += ["--retract", fact_id]
    else:
        kind = str(a.get("kind", "")).strip()
        content = str(a.get("content", "")).strip()
        if not kind or not content:
            return json.dumps({
                "error": "kind and content are required for action='record'",
            })
        argv += ["--kind", kind, "--content", content]
        if a.get("fact_id"):
            argv += ["--supersedes-id", str(a["fact_id"])]
        if a.get("supersedes"):
            argv += ["--supersedes", str(a["supersedes"])]

    if a.get("source"):
        argv += ["--source", str(a["source"])]

    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=30, env=_subprocess_env(root)
        )
    except Exception as e:  # noqa: BLE001 - write path must still return something
        return json.dumps({"error": f"store record failed: {e}"})

    if proc.returncode != 0:
        # record.ts prints a JSON refusal to stdout on a clean error; fall back
        # to stderr only when stdout is empty (a crash, not a refusal).
        out = (proc.stdout or "").strip()
        if out:
            return out
        return json.dumps({
            "error": "store record error",
            "stderr": (proc.stderr or "").strip(),
        })
    return proc.stdout or "{}"


def _handle_skill_record(a: Dict[str, Any]) -> str:
    """Serve a store-first skill write by shelling out to
    src/cli/record_skills.ts (JSON out). Same direct-actuator contract as
    _handle_store_record."""
    root = _resolve_sovereign_root()
    if root is None:
        return json.dumps({
            "error": (
                "Axiom sovereign package not found — cannot write the native "
                "skill store. Set AXIOM_SOVEREIGN_ROOT or write the root marker."
            ),
        })

    script = _node_cli(root, "record_skills")
    if not script.exists():
        return json.dumps({"error": f"record_skills.ts not found at {script}"})

    action = str(a.get("action", "")).strip()
    name = str(a.get("name", "")).strip()
    if not name:
        return json.dumps({"error": "name is required for skill actions"})

    argv = [_NODE, str(script), "--json", "--write", "--action", action, "--name", name]
    if action == "skill_update":
        content = a.get("content")
        if not isinstance(content, str) or not content.strip():
            return json.dumps({
                "error": "content (full SKILL.md) is required for action='skill_update'",
            })
        argv += ["--content", content]
        if a.get("category"):
            argv += ["--category", str(a["category"]).strip()]
    elif action == "skill_absorb":
        absorbed_into = str(a.get("absorbed_into", "")).strip()
        if not absorbed_into:
            return json.dumps({
                "error": "absorbed_into is required for action='skill_absorb'",
            })
        argv += ["--absorbed-into", absorbed_into]

    if a.get("source"):
        argv += ["--source", str(a["source"])]

    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=30, env=_subprocess_env(root)
        )
    except Exception as e:  # noqa: BLE001 - write path must still return something
        return json.dumps({"error": f"store skill record failed: {e}"})

    if proc.returncode != 0:
        out = (proc.stdout or "").strip()
        if out:
            return out
        return json.dumps({
            "error": "store skill record error",
            "stderr": (proc.stderr or "").strip(),
        })
    return proc.stdout or "{}"


def register(ctx) -> None:
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_tool(
        name="axiom_store",
        toolset="axiom",
        schema=_AXIOM_STORE_SCHEMA,
        handler=_handle_store_query,
    )
    ctx.register_tool(
        name="axiom_record",
        toolset="axiom",
        schema=_AXIOM_RECORD_SCHEMA,
        handler=_handle_store_record,
    )
