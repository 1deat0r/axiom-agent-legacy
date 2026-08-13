# Handoff — Terminal /connectors menu (ADR-0036)

## What
`/connectors` in the terminal client: a slash command (predictive popup above
the composer) that opens a two-level boxed menu for connecting the messaging
gateway to signal/telegram/discord/slack. Level 1 lists the four connectors,
each labeled with its live status (active / token set / no token / signal-cli
found); level 2 offers per-connector actions: Status & setup guide, Set bot
token (boxed paste field; Enter submits, Escape cancels without writing), and
Use now (rewrite the gateway systemd unit's `--transport`, daemon-reload,
restart). `/connectors status` and `/connectors help <name>` print the same
state without a menu. Fixes the shipped /profiles//projects menus, which
rendered but were keyboard-dead.

## Where (branch feat/connectors-menu, off origin/main da734103e)
- `src/gateway/connectors.ts` — pure registry: 4 transports, kind
  (token/signal-cli), token env var + CLI flag, credential hint,
  `connectorGuideLines`.
- `src/cli/gateway-service.ts` — injectable-deps controller:
  `readGatewayServiceState`, `readGatewayConnectorStatus`,
  `formatConnectorStatusLines`, `setConnectorToken`, `switchGatewayTransport`,
  `runConnectorsCommandArgs`, unit-text parsers/rewriters
  (`parseUnitTransport`, `parseUnitTokenVars`, `rewriteUnitTransport`,
  `setUnitEnvLine`, `setEnvFileLine`), `isProcessInServiceCgroup`,
  `defaultGatewayServiceDeps` (`AXIOM_GATEWAY_SERVICE` override).
- `src/modes/interactive/components/connector-token-input.ts` — boxed token
  paste field (Focusable, Enter submit / Escape cancel).
- `src/modes/interactive/components/workspace-selector.ts` — FIX: Focusable +
  `handleInput` forwarding to the SelectList; `WorkspaceOption.description`
  for status labels (keeps the "(current)" marker when no description).
- `src/modes/interactive/interactive-mode.ts` — `/connectors` dispatch +
  `handleConnectorsSlashCommand` / `openConnectorsMenu` /
  `openConnectorActionsMenu` / `promptForConnectorToken` / `printLocalLines`;
  `openWorkspaceSelector` now reuses the generic `openSelectorMenu`.
- `src/core/slash-commands.ts` — registered `/connectors`
  (`[status|help <name>]`, takesArgument).

## Verified how
- 86 new/extended tests, red-first: gateway/connectors (8), gateway-service
  (34), connector-token-input (5), workspace-selector (+5), slash-commands
  (+1), interactive-mode-connectors-command (4).
- Full `./test.sh`: 15 failed / 4798 passed — the 15 are ONLY the documented
  sandbox known-fails (daemon-serialized-refine 1, 4685×9 + 4603×4 EXDEV,
  kernel-rlm-heartbeat-skill real-kernel flake that passes standalone 3/3).
  biome clean; tsgo --noEmit clean.
- PTY probe (real binary, scratch AXIOM_HOME): `/connectors` appears in the
  predictive popup; menu opens with live statuses against the REAL gateway
  unit (Telegram — active, Signal — signal-cli found, Discord/Slack — no
  token); arrows navigate, Enter opens the per-connector actions, Escape
  closes BOTH levels; Status & setup guide and `/connectors status` print real
  state; the Set-token paste field opens and Esc-cancels (no write);
  /profiles Escape now closes (regression fix). "Use now" NOT exercised live
  (would restart the running gateway) — proven against fakes.

## Remaining / next
- Gateway-chat `/connectors` (read-only status over Telegram) — the terminal
  is the operator surface today.
- Signal switching checks signal-cli presence but not a linked account; a
  `signal-cli listAccounts` probe would make "signal-cli found" honest.
- Live cross-platform pass still operator-gated (tokens for >1 platform).
