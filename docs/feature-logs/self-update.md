# Gateway self-update — running log

Model: coding agent (axiom) · base origin/main 4229eabd1 · worktree .worktrees/self-update · branch feat/gateway-self-update · ADR-0034 · issue #15

- Preflight: read SOUL.md/AGENTS.md/CONTEXT, ADR-0001/0033, the gateway loop
  (gateway.ts), telegram offset-cursor store, CLI gateway-command options.
  Confirmed: transports persist their offset cursors under
  `<AXIOM_HOME>/gateway/` (telegram JsonOffsetStore), so a process restart
  resumes polling with no loss/replay; systemd unit runs with Restart=always.
- Plan written (docs/plans/self-update.md): /update check + /update now via a
  deferred post-reply action; restart only on success; inert unless
  AXIOM_UPDATE_REPO/--update-repo set.
- Red tests written (21): self-update runner gates (branch/dirty/ff-only/
  build/fetch), command outcomes (not-configured, behind, up-to-date, apply
  ok/fail, check fail), gateway end-to-end (reply-before-action ordering,
  restart spy on success only). All failed on missing modules -> red.
- Implemented: src/gateway/self-update.ts (UpdateConfig/UpdateShell/
  CliUpdateShell/checkUpdate/applyUpdate), commands/update.ts
  (scheduleUpdate deferred action), types.ts (GatewayUpdateApi + ctx fields
  update/afterReply/restartRequested/deliver), gateway.ts (deps update/
  updateShell/restart; handle() runs afterReply then restart),
  commands/index.ts + help.ts (registered + advertised), cli/gateway-command.ts
  (--update-repo/AXIOM_UPDATE_REPO, restart=process.exit(0)).
- Green: 21/21 new; full gateway suite 220/220; biome clean (1024 files);
  tsgo --noEmit clean.
- Docs: ADR-0034, CONTEXT "Self-update" term, this log, handoff.
- Floor: ./test.sh (scrubbed env) = 14 failed / 4666 passed vitest + tui 761/0
  + ai 69/0. The 14 are ONLY the documented sandbox known-fails
  (daemon-serialized-refine 1, 4685-daemon-client-modes 9 EXDEV,
  4603-worker-recovery 4 EXDEV). Two pre-existing main defects (mermaid
  subgraph title-role and the tui markdown-transform vitest-import crash) were
  carried here as cherry-picks of the same fixes already on
  feat/mermaid-render (55fe6d44a, 1e223daf5) so the floor holds on any branch
  containing the mermaid merge.

## Remaining (honest)
- Live end-to-end (real repo pull + npm build + systemd restart) is
  operator-gated; the seam is proven with a scripted shell + restart spy.
- Dependency changes needing `npm ci` are out of scope (build only).
- Restart cuts an in-flight completion on OTHER channels (same-channel is
  serialized); operator-initiated and documented in ADR-0034.
