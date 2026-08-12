# ADR-0034 — Gateway self-update (/update to latest main + clean restart)

## Status
Accepted (2026-08-13)

## Context
The operator updates the deployed gateway by hand: pull `main`, rebuild the
`axiom` bundle (`npm run build` in packages/coding-agent), and restart the
systemd unit. The gateway could do this itself — the operator already talks to
it over Telegram, and it runs under `axiom-telegram-gateway.service` with
`Restart=always`, so a clean self-exit IS the restart mechanism. The operator
wants: message `/update now`, the gateway updates to the latest commit on
`main`, restarts, comes back online, and keeps receiving messages — with no
message loss (the transport offset cursor persists on disk) and no manual
steps.

## Decision
Add a gateway-local `/update` command (ADR-0001: commands never reach the
model) plus a deferred post-reply action + restart hook in the gateway loop.

1. **Update runner** (`src/gateway/self-update.ts`): pure git+build steps
   behind an injected shell (`run(cmd[], cwd)`), so tests use a fake.
   `checkUpdate` fetches and compares HEAD to `origin/<branch>`; `applyUpdate`
   fetches, `merge --ff-only origin/<branch>`, then runs the build (default
   `npm run build` with cwd `packages/coding-agent`). All steps are safe
   against the running process: the gateway already loaded its bundle, and the
   new bundle is only picked up on the next spawn.
2. **Command** (`src/gateway/commands/update.ts`): `/update` = fetch + report
   ("at <sha>; latest <sha>"); `/update now` = generic "checking for
   updates…" reply, then a deferred action (`ctx.afterReply`) applies the
   update after the reply is delivered, reports the outcome through
   `ctx.deliver`, and sets `ctx.restartRequested` ONLY on success. Errors
   never restart — the gateway keeps running the old, known-good code.
3. **Gateway loop** (`gateway.ts`): after the command reply is sent, run
   `ctx.afterReply`, then call `deps.restart()` if requested. New
   `GatewayCommandContext` fields: `update?` (the runner API),
   `afterReply?`, `restartRequested?`, `deliver?`.
4. **CLI** (`gateway-command.ts`): `--update-repo <path>` / `AXIOM_UPDATE_REPO`
   — inert unless set (matches the security-fence/skill-capture pattern).
   Wires the real spawn shell and `restart = () => process.exit(0)`; systemd
   `Restart=always` brings the service back on the rebuilt bundle.

## Safety gates (refuse, never restart)
- No update config → "not configured" reply.
- Worktree not on the configured branch, or dirty (`git status --porcelain`)
  → refuse (a dirty tree could break the build or merge).
- Merge not fast-forwardable → refuse (no rebase/reset on a live tree).
- Build exit code != 0 → refuse (old code keeps serving).

## Consequences
- The operator updates the gateway from Telegram: `/update now`, one
  confirmation reply, a few minutes of build, the service returns on the new
  commit — no lost or replayed messages (Telegram/Discord/Slack offset cursors
  persist under `<AXIOM_HOME>/gateway/`).
- A restart cuts any completion in flight on OTHER channels (same-channel is
  serialized, so the command runs between messages). Operator-initiated and
  acceptable; the command is only honored from allowlisted senders.
- Dependency changes that need `npm ci` are out of scope — build only;
  documented in the handoff.
- No new dependencies; the only process-level effect is the opt-in
  `process.exit(0)` on an explicit, successful `/update now`.

## Alternatives considered
- An update daemon or a second supervisor process that swaps the gateway:
  rejected — systemd already restarts on exit; a second supervisor is new
  infrastructure with no owner.
- `/update` that shells out to a deploy script (`axiom-self-deploy.sh`):
  rejected — the runner must be typed, tested, and gate-checked in-repo, not
  hidden in an operator script.
- Rebase/checkout-based update (handles diverged history): rejected — a live
  gateway tree should only ever move by fast-forward; divergence is an
  operator conversation, not an automated decision.
