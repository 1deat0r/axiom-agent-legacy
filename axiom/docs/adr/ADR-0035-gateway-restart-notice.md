# ADR-0035 — Post-update "back online" restart notice (gateway)

## Status
Accepted (2026-08-13)

## Context
ADR-0034 added `/update now`: fetch, fast-forward, rebuild, then restart via
systemd `Restart=always`. It delivered a "restarting…" reply before the
restart, but nothing confirmed that the gateway actually came back. A naive
fix — a detached helper spawned by the dying process — is wrong: the helper
stays in the gateway's cgroup and is swept up by the restart, so it never
notifies (observed on 2026-08-13: the helper died mid-health-check).

## Decision
Let the *newly-started* gateway send the confirmation itself. Before exiting,
`/update now` records a restart notice (`{sha, channelId}`) in a
`RestartNoticeStore` at `<AXIOM_HOME>/gateway/restart-notice.json`; on boot,
`Gateway.start()` reads-and-clears it and delivers "✅ back online — updated to
<sha>" to the channel that ran `/update`. No detached helper, no cgroup escape:
the notification is sent by the fresh process, which cannot be killed by the
restart.

Also: widen `test.sh`'s env scrub to include `AXIOM_UPDATE_REPO` (and the
discord/slack bot tokens), so a live gateway's env cannot make the
transport-selection assertions drift in a neutral run.

## Consequences
- Operators get a positive confirmation that a self-update actually landed.
- The notice rides the ledger/deliver path, so it's recorded like any delivery.
- A leftover notice (e.g. crash before announce) simply re-announces on the
  next boot — harmless, self-clearing.
- `/update` remains inert unless `AXIOM_UPDATE_REPO`/`--update-repo` is set.
