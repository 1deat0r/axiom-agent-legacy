# Telegram Desktop GUI automation (tg-send)

One-shot message send from the local Telegram Desktop app to the active chat,
via AT-SPI text injection + the xdg-desktop-portal RemoteDesktop interface.
Used by agents to verify end-to-end message flow through a real GUI.

## Why this works (verified 2026-08-14)

- **AT-SPI** `EditableText.set_text_contents` puts text into Telegram's real
  input widget (send button turns blue = the real widget has it).
- The **RemoteDesktop portal** session needs a **VIRTUAL screencast source**
  (`SelectSources` with `types=4` on the same session handle) because this box
  has ZERO real outputs — KWin reports 0 outputs (headless placeholder). Without
  the virtual stream the portal logs `Only stream input` and silently drops
  every event.
- Then `NotifyKeyboardKeysym(0xFF0D)` (Return) sends the message. Keyboard
  events go to the focused window — no pointer hit-testing needed.
- Session order: `CreateSession` → `SelectDevices(types=3)` →
  `ScreenCast.SelectSources(session, types=4, multiple=false)` → `Start` →
  `NotifyKeyboardKeysym(Return)`.
- `rdclick.py` is the lower-level portal client (pointer moves/clicks/keys);
  `tg-send.py` wraps the full send flow with verification.
- `atspi-typedit.py` / `atspi-readfield.py` are the AT-SPI text helpers.

## Usage

```bash
export DISPLAY=:0
python3 tools/telegram-desktop-gui/tg-send.py "hello axiom"          # send
python3 tools/telegram-desktop-gui/tg-send.py "msg" --force          # overwrite draft
python3 tools/telegram-desktop-gui/tg-send.py "msg" --verbose        # diagnostics
```

Safety guards (all independently review-verified, 9.5/10 review gate PASS):

- Refuses to press Enter unless Telegram is the focused window
  (focus verified via KWin active window; AT-SPI focus state is unreliable
  headless).
- Refuses to overwrite an in-progress draft (`--force` overrides).
- Rejects empty input; retries Enter once; polls for field-clear instead of
  fixed sleeps; matches portal Response `handle_token`s so concurrent portal
  users can't corrupt the sequence; locale-flexible field matching.

## Verification

A send is only "done" when the field clears (message left the input box).
Ground truth of bot receipt lives outside this tool:

- inbound: `~/.axiom/agent/sessions/gw-*.jsonl` (`role:"user"` lines)
- outbound bot replies: `~/.axiom/gateway/ledger.jsonl` (new `ok:true` entries)

## History

- 2026-08-14: built end-to-end send (was: input events never reached app
  windows). Independent review round 1: 8.0/10 FAIL → all issues fixed
  (focus guard, draft protection, empty-input validation, token matching,
  retries) → independent re-review: **9.5/10 PASS**.
