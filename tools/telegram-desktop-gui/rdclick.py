#!/usr/bin/env python3
"""RemoteDesktop portal: full session + pointer click at relative offset + keys.

Usage: rdclick.py [--move dx dy] [--click] [--type text] [--enter]
"""
import sys, time
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
resp = {}
loop = GLib.MainLoop()


def on_response(conn, sender, path, iface, signal, params):
    resp['params'] = params
    loop.quit()


bus.signal_subscribe(
    'org.freedesktop.portal.Desktop',
    'org.freedesktop.portal.Request',
    'Response', None, None,
    Gio.DBusSignalFlags.NONE, on_response)

portal = Gio.DBusProxy.new_sync(
    bus, Gio.DBusProxyFlags.NONE, None,
    'org.freedesktop.portal.Desktop',
    '/org/freedesktop/portal/desktop',
    'org.freedesktop.portal.RemoteDesktop', None)


def call_and_wait(label, method, variant, secs=6, proxy=None):
    resp.clear()
    (proxy or portal).call_sync(method, variant, Gio.DBusCallFlags.NONE, 5000, None)
    GLib.timeout_add_seconds(secs, loop.quit)
    loop.run()
    if 'params' not in resp:
        print("TIMEOUT:", label)
        return None
    return resp['params']


ts = str(int(time.time()))
p = call_and_wait('session', 'CreateSession',
    GLib.Variant('(a{sv})', ({
        'handle_token': GLib.Variant('s', 'h1' + ts),
        'session_handle_token': GLib.Variant('s', 's1' + ts),
    },)))
if p is None:
    sys.exit("FAIL session")
session = p[1]['session_handle']

p = call_and_wait('select', 'SelectDevices',
    GLib.Variant('(oa{sv})', (session, {
        'handle_token': GLib.Variant('s', 'h2' + ts),
        'types': GLib.Variant('u', 3),
    },)))
if p is None:
    sys.exit("FAIL select")

# CRITICAL: the RemoteDesktop session is ALSO a ScreenCast session.
# Calling ScreenCast.SelectSource on the SAME session handle sets
# screenSharingEnabled=true, which makes Start create a real stream.
# Without it the portal logs "Only stream input" and drops all events.
screencast = Gio.DBusProxy.new_sync(
    bus, Gio.DBusProxyFlags.NONE, None,
    'org.freedesktop.portal.Desktop',
    '/org/freedesktop/portal/desktop',
    'org.freedesktop.portal.ScreenCast', None)
p = call_and_wait('selectsource', 'SelectSources',
    GLib.Variant('(oa{sv})', (session, {
        'handle_token': GLib.Variant('s', 'h2b' + ts),
        'types': GLib.Variant('u', 4),  # Virtual output (no real monitor needed)
        'multiple': GLib.Variant('b', False),
    },)), proxy=screencast)
if p is None:
    sys.exit("FAIL selectsource")
p = call_and_wait('start', 'Start',
    GLib.Variant('(osa{sv})', (session, '', {
        'handle_token': GLib.Variant('s', 'h3' + ts),
    },)))
if p is None:
    sys.exit("FAIL start")
print("SESSION READY", session)


def pointer_rel(dx, dy):
    portal.call_sync('NotifyPointerMotion',
        GLib.Variant('(oa{sv}dd)', (session, {}, float(dx), float(dy))),
        Gio.DBusCallFlags.NONE, 3000, None)


def click(btn=0x110):
    portal.call_sync('NotifyPointerButton',
        GLib.Variant('(oa{sv}iu)', (session, {}, btn, 1)),
        Gio.DBusCallFlags.NONE, 3000, None)
    time.sleep(0.1)
    portal.call_sync('NotifyPointerButton',
        GLib.Variant('(oa{sv}iu)', (session, {}, btn, 0)),
        Gio.DBusCallFlags.NONE, 3000, None)


def key(ks, state):
    portal.call_sync('NotifyKeyboardKeysym',
        GLib.Variant('(oa{sv}iu)', (session, {}, ks, state)),
        Gio.DBusCallFlags.NONE, 3000, None)


def enter():
    key(0xFF0D, 1); time.sleep(0.12); key(0xFF0D, 0)


def type_text(text):
    for ch in text:
        key(ord(ch), 1)
        time.sleep(0.04)
        key(ord(ch), 0)
        time.sleep(0.04)


args = sys.argv[1:]
i = 0
while i < len(args):
    a = args[i]
    if a == '--move':
        pointer_rel(args[i+1], args[i+2])
        print("moved rel", args[i+1], args[i+2])
        i += 3
    elif a == '--click':
        click()
        print("clicked")
        i += 1
    elif a == '--enter':
        enter()
        print("entered")
        i += 1
    elif a == '--type':
        type_text(args[i+1])
        print("typed", args[i+1])
        i += 2
    elif a == '--key':
        ks = int(args[i+1], 16)
        key(ks, 1); time.sleep(0.12); key(ks, 0)
        print("key", hex(ks))
        i += 2
    elif a == '--abs':
        portal.call_sync('NotifyPointerMotionAbsolute',
            GLib.Variant('(oa{sv}udd)', (session, {}, 0, float(args[i+1]), float(args[i+2]))),
            Gio.DBusCallFlags.NONE, 3000, None)
        print("abs moved", args[i+1], args[i+2])
        i += 3
    else:
        print("unknown", a)
        i += 1
print("DONE")
