#!/usr/bin/env python3
"""Read Telegram editable input field text (correct API)."""
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

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
            ifaces = child.get_interfaces()
        except Exception:
            name, ifaces = '', []
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
    print('NO FIELD', file=sys.stderr)
    sys.exit(1)

ti = field.get_text_iface()
n = ti.get_character_count()
# use get_string_at_offset for actual text
txt = ti.get_string_at_offset(0, Atspi.TextGranularity.LINE)
print('COUNT:', n)
print('TEXT:', repr(txt))
