# Feature log — Terminal /connectors menu (ADR-0036)

## Goal
Make connecting the gateway to signal/telegram/discord/slack a menu walk in
the terminal client instead of hand-editing the systemd unit.

## Done
- `/connectors` slash command (predictive popup) → two-level boxed menu with
  live per-connector status; status/help argument forms print into chat.
- Token paste field (Enter submit / Escape cancel, never echoes the token);
  tokens land in the unit `Environment=` line AND the gateway env file.
- Use now = rewrite `--transport` + daemon-reload + restart, guarded against
  missing tokens, self-cgroup restarts, and no-op re-switches.
- Fixed the keyboard-dead boxed selector (Focusable + input forwarding) — the
  /profiles//projects menus now navigate and Escape-close.

## Verified
- 86 new/extended tests green; full ./test.sh 4798 passed, 15 failed = only
  documented sandbox known-fails; biome + tsgo clean.
- PTY probe against the real gateway unit: popup, live statuses, two-level
  navigation, Esc at both levels, arg forms, paste-field cancel. Use now not
  fired live (unit-tested via fakes).

## Log
- 2026-08-13: red tests (connectors, gateway-service, workspace-selector,
  slash-commands) → registry + controller + menu wiring → green; PTY-verified
  the full flow incl. the Esc regression fix.
