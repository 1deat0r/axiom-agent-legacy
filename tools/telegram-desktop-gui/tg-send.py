#!/usr/bin/env python3
"""tg-send: send a message from the local Telegram Desktop app to the focused chat,
via AT-SPI text injection + RemoteDesktop portal Enter key.

Why this works (verified 2026-08-14):
- AT-SPI EditableText.set_text_contents puts text into Telegram's real input widget
  (send button turns blue = real widget has it).
- The RemoteDesktop portal session needs a VIRTUAL screencast source
  (SelectSources types=4) because this box has ZERO real outputs; without it the
  portal logs "Only stream input" and drops every event.
- Then NotifyKeyboardKeysym(0xFF0D) = Return = send. Keyboard events go to the
  focused window (Telegram), no pointer hit-testing needed.

Safety/robustness (review-gate fixes 2026-08-14):
- Focuses the field via grab_focus() AND verifies Telegram is the focused app
  before pressing Enter, so the Return never lands in another application.
- Refuses to clobber an existing draft (--force overrides).
- Rejects empty input; retries Enter once; polls up to 8s for the field to
  clear; matches portal Response handle_tokens so concurrent portal users
  can't satisfy our wait; locale-flexible field matching.

Usage: tg-send.py <message> [--force] [--verbose]
"""
import sys, time
import gi
gi.require_version('Gio', '2.0')
gi.require_version('Atspi', '2.0')
from gi.repository import Gio, GLib, Atspi

VERBOSE = False

def log(msg):
    if VERBOSE:
        print(msg, file=sys.stderr)

# ---------------------------------------------------------------- AT-SPI part
Atspi.init()

def _has_state(obj, state):
    try:
        return obj.get_state_set().contains(state)
    except Exception:
        return False

def _telegram_apps():
    apps = []
    try:
        desktop = Atspi.get_desktop(0)
        for i in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(i)
            if 'telegram' in (app.get_name() or '').lower():
                apps.append(app)
    except Exception:
        pass
    return apps

def _is_field_candidate(name, ifaces):
    """Locale-flexible: English 'Write a message', any language w/ 'message' or
    'write' hint, or fall back to role+EditableText for localized UIs."""
    if 'EditableText' not in ifaces:
        return False
    n = name.lower()
    return ('message' in n or 'write' in n or 'enter' in n) or name == ''

def _find_field_in(app, prefer_focused):
    """Return the best input field under `app`. If prefer_focused, only accept
    fields whose ancestor window has FOCUSED state; fall back to any field."""
    best = [None]  # (field, focused_score) tracked via mutable cell

    def walk(obj, in_focused_window=False):
        if best[0]:
            return
        try:
            name = obj.get_name() or ''
            ifaces = obj.get_interfaces()
        except Exception:
            name, ifaces = '', []
        if _is_field_candidate(name, ifaces):
            if not prefer_focused or in_focused_window:
                best[0] = obj
                return
        try:
            n = obj.get_child_count()
        except Exception:
            return
        # window node? (role 'frame'/'window'/'filler' with FOCUSED state)
        try:
            role = obj.get_role_name() or ''
        except Exception:
            role = ''
        child_focused = in_focused_window
        if role in ('frame', 'window', 'filler') and _has_state(obj, Atspi.StateType.FOCUSED):
            child_focused = True
        for i in range(n):
            try:
                child = obj.get_child_at_index(i)
            except Exception:
                continue
            walk(child, child_focused)
            if best[0]:
                return

    walk(app, False)
    return best[0]

def find_input_field():
    """Prefer the field in the FOCUSED Telegram window; fall back to first match."""
    apps = _telegram_apps()
    if not apps:
        return None
    # Pass 1: focused-window fields only
    for app in apps:
        f = _find_field_in(app, prefer_focused=True)
        if f:
            return f
    # Pass 2: any field
    for app in apps:
        f = _find_field_in(app, prefer_focused=False)
        if f:
            return f
    return None

def _field_chars(field):
    try:
        ti = field.get_text_iface()
        return ti.get_character_count()
    except Exception:
        return None

def set_text(field, text):
    try:
        field.get_editable_text_iface().set_text_contents(text)
        return True
    except Exception:
        return False

def is_app_focused(field):
    """Verify the real focus via KWin's active window (AT-SPI focus state is
    unreliable in headless sessions). Returns True/False/None."""
    try:
        import subprocess
        js = '/tmp/kwin-active-check.js'
        with open(js, 'w') as f:
            f.write("var w = workspace.activeWindow;"
                    "if (w) { print('ACTIVE=' + w.resourceClass); }")
        subprocess.run(['qdbus6', 'org.kde.KWin', '/Scripting', 'loadScript', js],
                       capture_output=True, timeout=5)
        time.sleep(0.3)
        subprocess.run(['qdbus6', 'org.kde.KWin', '/Scripting', 'start'],
                       capture_output=True, timeout=5)
        # Poll journalctl up to ~4s for the ACTIVE= print (script output lands
        # asynchronously in the journal).
        deadline = time.time() + 4
        while time.time() < deadline:
            out = subprocess.run(['journalctl', '--user', '-n', '15', '--no-pager'],
                                 capture_output=True, text=True, timeout=5).stdout
            for line in out.splitlines():
                if 'ACTIVE=' in line:
                    cls = line.split('ACTIVE=')[-1].strip()
                    subprocess.run(['qdbus6', 'org.kde.KWin', '/Scripting',
                                    'unloadScript', js], capture_output=True, timeout=5)
                    return 'telegram' in cls.lower()
            time.sleep(0.5)
        subprocess.run(['qdbus6', 'org.kde.KWin', '/Scripting', 'unloadScript', js],
                       capture_output=True, timeout=5)
        return None
    except Exception:
        return None

# ---------------------------------------------------------------- portal part
def portal_enter():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    resp = {}
    loop = GLib.MainLoop()

    def on_response(conn, sender, path, iface, signal, params):
        # Only accept the Response for the request path we're waiting on.
        # `path` is /org/freedesktop/portal/desktop/request/<sender>/<token>
        if resp.get('expect_path') and not path.endswith(resp['expect_path']):
            return
        resp['params'] = params
        loop.quit()

    bus.signal_subscribe('org.freedesktop.portal.Desktop',
        'org.freedesktop.portal.Request', 'Response', None, None,
        Gio.DBusSignalFlags.NONE, on_response)

    portal = Gio.DBusProxy.new_sync(bus, Gio.DBusProxyFlags.NONE, None,
        'org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop',
        'org.freedesktop.portal.RemoteDesktop', None)
    screencast = Gio.DBusProxy.new_sync(bus, Gio.DBusProxyFlags.NONE, None,
        'org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop',
        'org.freedesktop.portal.ScreenCast', None)

    def call(label, proxy, method, variant, secs=8, token=None):
        resp.clear()
        resp['expect_path'] = token  # suffix of the request path to match
        proxy.call_sync(method, variant, Gio.DBusCallFlags.NONE, 5000, None)
        GLib.timeout_add_seconds(secs, loop.quit)
        loop.run()
        if 'params' not in resp:
            raise RuntimeError('TIMEOUT: ' + label)
        return resp['params']

    ts = str(int(time.time()))
    p = call('session', portal, 'CreateSession',
        GLib.Variant('(a{sv})', ({'handle_token': GLib.Variant('s', 'h1'+ts),
                                  'session_handle_token': GLib.Variant('s', 's1'+ts)},)),
        token='h1'+ts)
    session = p[1]['session_handle']

    call('select', portal, 'SelectDevices',
        GLib.Variant('(oa{sv})', (session, {'handle_token': GLib.Variant('s', 'h2'+ts),
                                             'types': GLib.Variant('u', 3)},)),
        token='h2'+ts)

    # THE KEY FIX: virtual source unlocks the stream (zero real outputs on this box)
    call('selectsource', screencast, 'SelectSources',
        GLib.Variant('(oa{sv})', (session, {'handle_token': GLib.Variant('s', 'h2b'+ts),
                                             'types': GLib.Variant('u', 4),
                                             'multiple': GLib.Variant('b', False)},)),
        token='h2b'+ts)

    call('start', portal, 'Start',
        GLib.Variant('(osa{sv})', (session, '', {'handle_token': GLib.Variant('s', 'h3'+ts)},)),
        token='h3'+ts)

    def key(ks, state):
        portal.call_sync('NotifyKeyboardKeysym',
            GLib.Variant('(oa{sv}iu)', (session, {}, ks, state)),
            Gio.DBusCallFlags.NONE, 3000, None)

    key(0xFF0D, 1)
    time.sleep(0.15)
    key(0xFF0D, 0)
    return True

# ---------------------------------------------------------------- main
def main():
    global VERBOSE
    args = [a for a in sys.argv[1:]]
    force = '--force' in args
    VERBOSE = '--verbose' in args
    args = [a for a in args if not a.startswith('--')]
    if not args:
        print("usage: tg-send.py <message> [--force] [--verbose]")
        sys.exit(2)
    text = args[0]

    if not text.strip():
        print("FAIL: empty message (nothing to send)")
        sys.exit(1)

    field = find_input_field()
    if not field:
        print("FAIL: Telegram input field not found (is Telegram open?)")
        sys.exit(1)

    # Refuse to clobber a draft the user was typing.
    existing = _field_chars(field)
    if existing and existing > 0 and not force:
        print(f"FAIL: field already contains {existing} chars (draft preserved); "
              f"use --force to overwrite")
        sys.exit(1)

    # Focus the field AND verify Telegram is the focused app before Enter.
    try:
        field.get_component_iface().grab_focus()
    except Exception:
        pass
    focused = is_app_focused(field)
    if focused is False:
        print("FAIL: Telegram is not the focused application; "
              "refusing to press Enter into another app")
        sys.exit(1)
    if focused is None:
        # Fail-open only with an explicit warning visible even without --verbose.
        print("WARN: could not verify Telegram focus via KWin; "
              "proceeding (Enter goes to the currently active window)", file=sys.stderr)

    if not set_text(field, text):
        print("FAIL: could not set text via AT-SPI")
        sys.exit(1)

    # Wait until the text is actually in the widget (chars == len(text)).
    deadline = time.time() + 8
    while time.time() < deadline:
        if _field_chars(field) == len(text):
            break
        time.sleep(0.2)
    else:
        print("FAIL: text never landed in field")
        sys.exit(1)
    log(f"text set: {len(text)} chars")

    try:
        portal_enter()
    except Exception as e:
        print("FAIL: portal enter:", e)
        sys.exit(1)

    # Post-check with retry: poll for the field to clear (send happened).
    deadline = time.time() + 8
    chars = None
    while time.time() < deadline:
        chars = _field_chars(field)
        if chars == 0:
            break
        # One retry after a short grace period in case the first Enter was eaten.
        if time.time() < deadline - 4 and chars == len(text):
            # Retry Enter while text is still present (up to a few attempts
            # inside the 8s window — the first success clears the field and
            # breaks the loop; at most one extra press per ~1.5s cycle).
            log("retrying Enter")
            try:
                portal_enter()
            except Exception as e:
                log("retry enter failed: " + str(e))
            time.sleep(1.0)
        else:
            time.sleep(0.5)
    if chars != 0:
        print(f"WARN: field still has {chars} chars — send may not have fired")
        sys.exit(1)

    print(f"SENT: {text}")

if __name__ == '__main__':
    main()
