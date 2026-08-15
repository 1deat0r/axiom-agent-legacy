# Handoff — 2026-08-15 (build session: #58 cron milestone, built and verified)

## What this session did

Built the settled #58 scope on `feat/cron-spine` (main was untouched since
a50da7b46). Three commits land the code; the floor runs at the merge.

1. **Claim race, as the pair (b1c744f7f).** `AgentCronJobStore.claimDue`
   gained an optional claim filter (default claim-all, back-compat), threaded
   from `AgentCronSchedulerHooks.claimFilter` through every sweep.
   `isGatewayCronJob` (`source === "cron" && channelId !== undefined`) is the
   new shared predicate: GatewayCron claims exactly it, the daemon claims its
   complement. The runJob guard stays the backstop. Red-first pins both
   directions: a due heartbeat survives a gateway sweep untouched, and a
   gateway cron job survives a daemon sweep untouched.
2. **`/cron list` and `/cron rm` gateway-only (46c168e7b).** Both filter on
   `isGatewayCronJob`; heartbeats and daemon schedule jobs never render as
   cron jobs and cannot be cancelled from the gateway.
3. **Live-verification cron-spine check (6fbbba556).** The catalog's sixth
   check boots the compiled GatewayCron in a temp home with a stubbed
   completion, forces a sweep, and proves claim → run → deliver → ledger —
   with a due heartbeat in the same store file asserted untouched (the race
   this check would have caught). No tokens, runs whenever the build exists.
   Passes against the real binary this session.
4. **ADR-0084** records what cron is, the partition fix, the gateway-only
   command surface, the live-verification home, live vs deferred (pause/resume
   deferred; deliverTo fan-out = wanted follow-up; ADR-0053 boundary), and the
   verified mechanics (catch-up coalescing, once-completion, local-TZ
   five-field, interval floors, durable dispatch recovery, per-session lanes).
   **ADR-0022**'s stale "spine is a follow-up once the rebase happens" line is
   refreshed.

## Two deviations from the settled text (recorded, both in the ADR)

- **The daemon filter is the complement, not heartbeats-only.** The scoping
  premise "`source: "cron"` has exactly one creation site" missed the
  daemon's `cron_add` (`axiom schedule add`, `createCronJobForState`) — a
  literal heartbeats-only daemon filter would strand those jobs (never
  claimed by anyone). The complement (`!isGatewayCronJob`) still partitions
  the store exactly and keeps `axiom schedule` working; pinned by the 4257
  regression (a daemon cron job fires through the scheduler).
- **Recorded residual:** interrupted-dispatch recovery on scheduler start is
  unfiltered, so a booting scheduler resolves any dangling dispatch in the
  shared store (a gateway boot can mark a daemon once-job interrupted). Latent
  like the fixed race (the shared file does not exist in production yet);
  recovery filtering is a follow-up issue.

## Verified

- Red first, then green: gateway/cron.test.ts, cron-jobs.test.ts,
  daemon-mode.test.ts, commands.test.ts, live-verification.test.ts.
- Targeted suites green: cron (88), daemon-mode (192), six heartbeat
  regressions (62), live-verification catalog (20).
- `node tools/live-verification/run.mjs --check cron-spine` PASSes on the
  built dist (unit + real-binary, no mock blur).
- Pre-commit hook (biome + tsgo + installer + browser smoke) green on every
  commit. The full `./test.sh` floor runs at the merge.

## Tracker state

- #58: built on feat/cron-spine, awaiting the merge-floor and the audit
  comment. #52 / #53 owner-blocked, untouched. #59 needs-triage, after #58.
- Follow-up to file after close: interrupted-dispatch recovery filtering in
  the shared store (needs-triage).
- docs/hermes-improvements.html still untracked — not ours.
