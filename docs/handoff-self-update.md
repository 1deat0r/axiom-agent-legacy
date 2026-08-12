# Handoff — Gateway self-update (/update, ADR-0034)

## What
Gateway-local `/update` (check + report) and `/update now` (fetch, ff-only
merge of origin/main, rebuild, restart). The operator updates the gateway from
Telegram: the acknowledgement reply is delivered BEFORE the slow fetch/build,
the outcome follows on the same channel, and the process restarts only on
success — systemd `Restart=always` brings the service back on the new bundle,
and transport offset cursors persist, so messages are neither lost nor
replayed.

## Where (branch feat/gateway-self-update, off origin/main 4229eabd1)
- `src/gateway/self-update.ts` — UpdateConfig/UpdateShell/CliUpdateShell,
  `checkUpdate` (branch + clean-tree gates, fetch, current vs origin/main),
  `applyUpdate` (fetch, `merge --ff-only`, `npm run build` in
  packages/coding-agent, from/to shas).
- `src/gateway/commands/update.ts` — `/update` / `/update now`; deferred
  `ctx.afterReply` action applies the update after the reply, reports via
  `ctx.deliver`, sets `ctx.restartRequested` only on success.
- `src/gateway/gateway.ts` — deps `update`/`updateShell`/`restart`; handle()
  runs the deferred action after delivering the reply, then restarts.
- `src/gateway/types.ts` — GatewayUpdateApi + ctx fields
  update/afterReply/restartRequested/deliver.
- `src/cli/gateway-command.ts` — `--update-repo <path>` / `AXIOM_UPDATE_REPO`
  (inert unless set); `restart = () => process.exit(0)`.

## Verified how
- 21 new tests red-first (runner gates, command outcomes, gateway end-to-end
  ordering + restart spy); full gateway suite 220/220; biome clean; tsgo
  --noEmit clean; `./test.sh` floor = 14 failed/4666 passed — the 14 are ONLY
  the documented sandbox known-fails; tui 761/0, ai 69/0. Carried (cherry-
  picked) the two pre-existing main fixes from feat/mermaid-render so the
  floor holds on this branch.

## Live-path caveat (operator-gated)
- Real repo pull + npm build + systemd restart not exercised here — scripted
  shell + restart spy prove the seam. The operator wires it by adding
  `AXIOM_UPDATE_REPO=/home/mustbearn/Projects/axiom-agent` to
  ~/.config/axiom-gateway.env and restarting the unit; the worktree there must
  be on `main` and clean.

## Remaining / next
- Dependency changes needing `npm ci` are out of scope (build only).
- Optional: surface the update status in /help like the /model status line.
