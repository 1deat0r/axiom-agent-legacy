"""E2E tests for the ported native-store-bridge plugin (port #3, issue #64).

The plugin mirrors Hermes ``memory`` / ``skill_manage`` writes into Axiom's
native stores and serves the store-first read/write tools by shelling out to
the TypeScript sovereign CLI (``node axiom/sovereign/src/cli/*.ts``) instead of
3V0's Python scripts. These tests exercise the real subprocess boundary against
a temp store, proving the re-pointed plugin writes and reads the
byte-compatible stores — not just that it imports.

The E2E cases (anything that shells out to ``node``) skip cleanly when Node or
the sovereign CLIs are absent; the pure/unit cases always run.
"""

import importlib.util
import json
import shutil
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PLUGIN_INIT = REPO / "axiom" / "plugin" / "native-store-bridge" / "__init__.py"
CLI_DIR = REPO / "axiom" / "sovereign" / "src" / "cli"

_node_available = shutil.which("node") is not None and (CLI_DIR / "ingest.ts").is_file()
requires_node = pytest.mark.skipif(
    not _node_available,
    reason="node runtime or sovereign TS CLIs not available",
)


def _load_plugin():
    spec = importlib.util.spec_from_file_location("native_store_bridge", PLUGIN_INIT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def plugin():
    return _load_plugin()


@pytest.fixture()
def store_env(monkeypatch, tmp_path):
    """Point every AXIOM_* path at an isolated temp dir for the subprocess."""
    monkeypatch.setenv("AXIOM_STORE", str(tmp_path / "memory.json"))
    monkeypatch.setenv("AXIOM_SKILL_STORE", str(tmp_path / "skills.json"))
    monkeypatch.setenv("AXIOM_PROFILE_MEM", str(tmp_path / "memories"))
    monkeypatch.setenv("AXIOM_SKILLS_DIR", str(tmp_path / "skills"))
    return tmp_path


# -- pure / unit -----------------------------------------------------------


def test_is_axiom_cwd(plugin, monkeypatch, tmp_path):
    repo = tmp_path / "axiom-agent"
    axiom_home = tmp_path / ".axiom"
    monkeypatch.setenv("AXIOM_HOME", str(axiom_home))

    assert plugin._is_axiom_cwd(str(repo), repo) is True
    assert plugin._is_axiom_cwd(str(repo / "axiom" / "sovereign"), repo) is True
    assert plugin._is_axiom_cwd(str(axiom_home), repo) is True
    assert plugin._is_axiom_cwd(str(Path.home()), repo) is True
    # A sibling project sharing the profile must not mirror into Axiom's stores.
    assert plugin._is_axiom_cwd(str(tmp_path / "f1nance"), repo) is False
    # Unknown/empty cwd fails open (primary project).
    assert plugin._is_axiom_cwd(None, repo) is True
    assert plugin._is_axiom_cwd("", repo) is True


def test_subprocess_env_sets_axiom_overrides(plugin, tmp_path):
    sovereign = tmp_path / "sovereign"
    env = plugin._subprocess_env(sovereign)
    assert env["AXIOM_STORE"] == str(sovereign / "data" / "memory.json")
    assert env["AXIOM_SKILL_STORE"] == str(sovereign / "data" / "skills.json")
    assert env["AXIOM_PROFILE_MEM"] == str(plugin._profile_home() / "memories")
    assert env["AXIOM_SKILLS_DIR"] == str(plugin._profile_home() / "skills")


def test_subprocess_env_respects_explicit_override(plugin, monkeypatch, tmp_path):
    monkeypatch.setenv("AXIOM_STORE", str(tmp_path / "custom.json"))
    env = plugin._subprocess_env(tmp_path / "sovereign")
    assert env["AXIOM_STORE"] == str(tmp_path / "custom.json")


# -- E2E (real node subprocess against a temp store) -----------------------


@requires_node
def test_mirror_memory_writes_store(plugin, store_env):
    plugin._mirror_memory(
        {"target": "memory", "action": "add", "content": "first fact"},
        json.dumps({"success": True}),
        session_id="",
    )
    store = json.loads((store_env / "memory.json").read_text())
    assert any(
        f["content"] == "first fact" and f["kind"] == "memory"
        for f in store["facts"]
    )


@requires_node
def test_mirror_skill_writes_skill_store(plugin, store_env):
    content = "---\nname: foo-skill\ndescription: A mirrored skill.\n---\n\n# Foo\n"
    plugin._mirror_skill(
        {"action": "create", "name": "foo-skill", "content": content},
        json.dumps({"success": True}),
        session_id="",
    )
    skills = json.loads(plugin._handle_store_query({"action": "skills"}))["skills"]
    assert any(s["name"] == "foo-skill" for s in skills)


@requires_node
def test_store_query_summary(plugin, store_env):
    out = plugin._handle_store_query({"action": "summary"})
    data = json.loads(out)
    assert "error" not in data
    for key in ("facts", "fact_versions", "active_skills", "skill_versions", "skill_states"):
        assert key in data


@requires_node
def test_store_record_then_retract(plugin, store_env):
    out = plugin._handle_store_record(
        {"action": "record", "kind": "memory", "content": "hello"}
    )
    data = json.loads(out)
    assert data.get("ok") is True, data
    fact_id = data["fact"]["id"]

    facts = json.loads(
        plugin._handle_store_query({"action": "facts", "kind": "memory"})
    )["facts"]
    assert any(f["content"] == "hello" for f in facts)

    out2 = plugin._handle_store_record({"action": "retract", "fact_id": fact_id})
    data2 = json.loads(out2)
    assert data2.get("ok") is True, data2

    facts = json.loads(
        plugin._handle_store_query({"action": "facts", "kind": "memory"})
    )["facts"]
    assert all(f["content"] != "hello" for f in facts)


@requires_node
def test_store_skill_update(plugin, store_env):
    content = "---\nname: demo-skill\ndescription: A store-first skill.\n---\n\n# Demo\n"
    out = plugin._handle_store_record(
        {"action": "skill_update", "name": "demo-skill", "content": content}
    )
    data = json.loads(out)
    assert data.get("ok") is True, data

    skills = json.loads(plugin._handle_store_query({"action": "skills"}))["skills"]
    assert any(s["name"] == "demo-skill" for s in skills)

    # The derived-view projection landed in the profile skills dir.
    projected = store_env / "skills" / "demo-skill" / "SKILL.md"
    assert projected.is_file()
