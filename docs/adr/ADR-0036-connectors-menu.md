# ADR-0036 — Terminal /connectors menu (gateway transport + credential control)

## Status
Accepted (2026-08-13)

## Context
Connecting a new messaging platform to the gateway is manual operator work:
edit the systemd unit's `--transport` flag and `Environment=` token lines (or
the env file), `daemon-reload`, `restart` — all by hand, remembered from the
CLI usage string. The terminal client already has boxed slash-command menus
(/profiles, /projects), so the operator expects the same for connectors:
type `/connectors` above the composer and configure signal/telegram/discord/
slack from a menu.

While wiring the menu, PTY probing showed the boxed selector itself was
keyboard-dead: `WorkspaceSelectorComponent` never forwarded keypresses to its
`SelectList` (its unit tests drove `getSelectList().handleInput()` directly,
bypassing the overlay routing). `/profiles`//`/projects` rendered but could
not be navigated or closed with Escape.

## Decision
- A pure connector registry (`src/gateway/connectors.ts`): the four transports
  (`axiom gateway --transport` ids), their kind (bot-token vs signal-cli), the
  env var + CLI flag each token rides, and the credential source hint.
- A gateway service controller (`src/cli/gateway-service.ts`) with injected
  deps (systemctl exec, unit/env-file read/write, process env, cgroup path):
  - `readGatewayServiceState` — `systemctl --user show` (ActiveState,
    FragmentPath) + parse the unit's `--transport` and `Environment=` bot-token
    vars; empty state when the unit is absent.
  - `readGatewayConnectorStatus` — per-connector status label: `active` when
    the running service boots under that transport, `token set`/`no token`
    (token from process env, unit Environment, or the env file), `signal-cli
    found`/`missing` (PATH probe).
  - `setConnectorToken` — writes the token into the unit `Environment=` line
    AND `~/.config/axiom-gateway.env`; never echoes it back.
  - `switchGatewayTransport` — rewrites the unit's `--transport`, daemon-
    reload, restart. Refuses when the token is missing, when already on that
    transport, or when the process lives inside the service cgroup (a restart
    would kill the session); warns when switching to signal without signal-cli
    on PATH.
  - The service name is `AXIOM_GATEWAY_SERVICE` (default
    `axiom-telegram-gateway.service`), so the controller is not hard-wired to
    this box.
- A `/connectors` slash command in the terminal client: `status` and
  `help <name>` print lines into the chat; a bare `/connectors` opens a
  two-level boxed menu — pick a connector (labeled with its live status), then
  an action (Status & setup guide / Set bot token / Use now — restart the
  gateway as this connector). Setting a token opens a boxed paste field
  (Enter submits, Escape cancels without writing).
- Fix `WorkspaceSelectorComponent`: implement `Focusable` and forward
  `handleInput` to its `SelectList`, so every boxed selector menu (including
  the existing /profiles//projects) navigates with arrows, selects with Enter,
  and closes with Escape. `WorkspaceOption` gains an optional `description`
  for the per-connector status labels.

## Consequences
- Connecting a platform is a menu walk + a token paste; switching transports
  is one Enter and a service restart, guarded against self-kill and missing
  credentials.
- All gateway service operations are unit-tested against fakes; the TUI
  handler is a thin dispatch over the same functions.
- The /profiles//projects menus gain working keyboard navigation and Escape
  (regression fix, PTY-verified).
- Gateway-chat `/connectors` (read-only status over Telegram) is a recorded
  follow-up — the terminal is the operator surface; nothing here touches the
  gateway's own command set.
