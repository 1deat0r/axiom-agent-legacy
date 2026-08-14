#!/usr/bin/env python3
"""Set text in Telegram's REAL editable input (has EditableText+Text interfaces).

Usage: atspi-typedit.py "message text" [--send]
"""
import sys, time, subprocess
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

msg = sys.argv[1]
do_send = '--send' in sys.argv
Atspi.init()
field = None


def walk(obj):
    global field
    if field:
        return
    try:
        n = obj.get_child_count()
    except Exception:
        return
    for i in range(n):
        try:
            child = obj.get_child_at_index(i)
        except Exception:
            continue
        try:
            name = child.get_name() or ''
        except Exception:
            name = ''
        try:
            ifaces = child.get_interfaces()
        except Exception:
            ifaces = []
        if 'Write a message' in name and 'EditableText' in ifaces:
            field = child
            return
        walk(child)


desktop = Atspi.get_desktop(0)
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if 'Telegram' in (app.get_name() or ''):
        walk(app)

if not field:
    print('NO EDITABLE FIELD FOUND', file=sys.stderr)
    sys.exit(1)

try:
    field.grab_focus()
    print('grab_focus: ok')
except Exception as e:
    print('focus err:', e, file=sys.stderr)

time.sleep(0.4)

try:
    et = field.get_editable_text_iface()
    et.set_text_contents(msg)
    print('text set via EditableText')
except Exception as e:
    print('editable err:', e, file=sys.stderr)
    try:
        field.set_text_contents(msg)
        print('text set (direct)')
    except Exception as e2:
        print('direct err:', e2, file=sys.stderr)

time.sleep(0.3)
try:
    ti = field.get_text_iface()
    print('field now:', repr(ti.get_text(0, ti.character_count)))
except Exception as e:
    print('read err:', e, file=sys.stderr)

if do_send:
    time.sleep(0.3)
    # try AT-SPI action first, else Enter via action interface
    try:
        n = field.get_n_actions()
        print('actions:', n)
        for a in range(n):
            print(' action', a, field.get_action_name(a))
    except Exception as e:
        print('action list err:', e, file=sys.stderr)
    subprocess.run(['ydotool', 'key', '28:1', '28:0'], check=True)
    print('enter sent (ydotool)')
