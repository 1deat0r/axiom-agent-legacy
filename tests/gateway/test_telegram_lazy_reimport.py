"""Regression test: check_telegram_requirements() must rebind TypeHandler.

When ``python-telegram-bot`` is missing at adapter import time, the module-level
import block falls back to ``Any`` for every PTB symbol and sets
``TELEGRAM_AVAILABLE = False``. ``check_telegram_requirements()`` then
lazy-installs the SDK and re-imports it, rebinding those aliases. ``TypeHandler``
was omitted from that re-import/rebind, so ``_register_handlers`` called
``TypeHandler(Update, ...)`` == ``Any(...)``, raising ``TypeError: Any cannot be
instantiated`` and failing the whole Telegram connect (observed at gateway boot
on a profile whose venv had not yet lazy-installed the SDK).
"""

import typing

import pytest

import plugins.platforms.telegram.adapter as telegram_mod


def _real_telegram_importable() -> bool:
    try:
        import telegram.ext  # noqa: F401

        return True
    except ImportError:
        return False


@pytest.mark.skipif(
    not _real_telegram_importable(),
    reason="python-telegram-bot not installed in this environment",
)
def test_check_requirements_rebinds_typehandler(monkeypatch):
    """After a simulated failed import, check_telegram_requirements() rebinds TypeHandler."""
    from telegram.ext import TypeHandler as RealTypeHandler

    # Simulate the fallback state left behind by the module-level
    # ``except ImportError`` branch: aliases are ``typing.Any`` and the flag is
    # False, exactly what a real gateway sees before the lazy install.
    monkeypatch.setattr(telegram_mod, "TELEGRAM_AVAILABLE", False)
    monkeypatch.setattr(telegram_mod, "TypeHandler", typing.Any)
    monkeypatch.setattr(telegram_mod, "TelegramMessageHandler", typing.Any)
    monkeypatch.setattr(telegram_mod, "Application", typing.Any)

    # Avoid a real lazy-install subprocess side effect inside the test.
    monkeypatch.setattr("tools.lazy_deps.ensure", lambda *a, **k: None)

    assert telegram_mod.check_telegram_requirements() is True
    assert telegram_mod.TELEGRAM_AVAILABLE is True
    assert telegram_mod.TypeHandler is RealTypeHandler
    assert telegram_mod.TypeHandler is not typing.Any
    assert telegram_mod.TelegramMessageHandler is not typing.Any
    assert telegram_mod.Application is not typing.Any
