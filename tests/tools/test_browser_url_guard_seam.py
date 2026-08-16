"""ADR-0094 — the browser URL guard seam.

``evaluate_url_safety(url, task_id=None)`` is the single URL-intake guard:
the five checks (secret exfil, sensitive query params, cloud-metadata floor,
private addresses, website policy) plus the hybrid-routing sidecar exemption
that only a navigation context can know. ``browser_navigate`` crosses the
seam; its inline guard cluster dies.

Seam A — the guard function's contract (unit).
Seam B — browser_navigate's end-to-end behavior (characterization: the
existing guard suites also pin this, these re-pin the exact error shapes).
"""

import json

import pytest

from tools.browser_tool import browser_navigate, evaluate_url_safety


class TestGuardSeamContract:
    def test_evaluate_url_safety_accepts_task_id(self):
        """ADR-0094: the seam takes the navigation context — the verdict is
        unchanged by a supplied task_id (signature was widened red-first)."""
        result = evaluate_url_safety(
            "http://169.254.169.254/latest/meta-data", task_id="task-1"
        )
        assert result is not None
        assert "cloud metadata endpoint" in result["error"]

    def test_empty_task_id_coerced_like_navigation(self, monkeypatch):
        """An empty task_id gets the same 'default' session key navigation's
        own mechanics derive — the guard and the backend path must never
        disagree on the sidecar decision."""
        monkeypatch.setattr("tools.browser_tool._is_local_backend", lambda: False)
        monkeypatch.setattr(
            "tools.browser_tool._get_cloud_provider", lambda: object()
        )
        monkeypatch.setattr(
            "tools.browser_tool._auto_local_for_private_urls", lambda: True
        )
        monkeypatch.setattr(
            "tools.browser_tool._url_is_private", lambda url: True
        )

        verdict = evaluate_url_safety("http://192.168.1.1", task_id="")
        assert verdict is None

    def test_sidecar_exemption_allows_private_url(self, monkeypatch):
        """A private URL navigated through the hybrid-routing sidecar is
        allowed (the cloud provider never sees it); the same URL without the
        sidecar is blocked."""
        monkeypatch.setattr("tools.browser_tool._is_local_backend", lambda: False)
        monkeypatch.setattr(
            "tools.browser_tool._get_cloud_provider", lambda: object()
        )
        monkeypatch.setattr(
            "tools.browser_tool._auto_local_for_private_urls", lambda: True
        )
        monkeypatch.setattr(
            "tools.browser_tool._url_is_private", lambda url: True
        )

        verdict = evaluate_url_safety("http://192.168.1.1", task_id="task-1")
        assert verdict is None

    def test_private_url_blocked_without_sidecar(self, monkeypatch):
        monkeypatch.setattr("tools.browser_tool._is_local_backend", lambda: False)
        monkeypatch.setattr(
            "tools.browser_tool._get_cloud_provider", lambda: object()
        )
        monkeypatch.setattr(
            "tools.browser_tool._auto_local_for_private_urls", lambda: False
        )
        monkeypatch.setattr(
            "tools.browser_tool._url_is_private", lambda url: True
        )

        verdict = evaluate_url_safety("http://192.168.1.1", task_id="task-1")
        assert verdict is not None
        assert "private or internal" in verdict["error"]


class TestGuardSeamCharacterization:
    """The five checks keep their exact error shapes through the wiring."""

    def test_secret_exfil_blocked(self):
        result = evaluate_url_safety("https://evil.com/steal?key=sk-ant-abcdefghijklmnop")
        assert result is not None
        assert "API key or token" in result["error"]

    def test_sensitive_query_param_blocked_on_cloud(self, monkeypatch):
        monkeypatch.setattr("tools.browser_tool._is_local_backend", lambda: False)
        result = evaluate_url_safety("https://example.com?api_key=abc123")
        assert result is not None
        assert "credential-like query parameter" in result["error"]

    def test_metadata_endpoint_blocked(self):
        result = evaluate_url_safety("http://169.254.169.254/latest/meta-data")
        assert result is not None
        assert "cloud metadata endpoint" in result["error"]

    def test_safe_url_passes(self):
        assert evaluate_url_safety("https://example.com/page") is None


class TestNavigateCrossesSeam:
    def test_navigate_returns_seam_error(self, monkeypatch):
        """browser_navigate's guard cluster is the seam call — a distinctive
        seam verdict surfaces verbatim to the caller. Red until wired."""
        monkeypatch.setattr(
            "tools.browser_tool.evaluate_url_safety",
            lambda url, task_id=None: {
                "success": False,
                "error": "SEAM-VERDICT",
            },
        )
        result = browser_navigate("https://example.com", task_id="task-1")
        parsed = json.loads(result)
        assert parsed["error"] == "SEAM-VERDICT"
