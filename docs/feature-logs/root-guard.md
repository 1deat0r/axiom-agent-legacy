# Feature log: Root guard v2 (ADR-0052, issue #17)

Date: 2026-08-14. Branch `feat/root-guard`, worktree `.worktrees/root-guard`.
ADR renumbered 0051 -> 0052 (main took 0050/0051).

## What shipped

- `core/root-guard/paths.ts` — literal path-token extraction from shell/ipython
  text (absolute, tilde, relative-with-slash, `..`; comments stripped; `$VAR`
  indirection invisible by design).
- `core/root-guard/scope.ts` — lexical containment classification: deny wins
  (even inside the root), then inside-root, then allow prefixes.
- `core/root-guard/store.ts` — file-backed approval state, root-scoped:
  pending requests, decisions, append-only grants + audit JSONL.
- `extensions/root-guard/` — the `tool_call` gate for bash/ipython (inert
  unless anchored) plus the `request_root_access` approval tool (files a
  plain-English request and waits, poll + abortable, default 5 min; grants
  idempotent; store failure fails closed).
- Workspace guard (ADR-0018) gains allow prefixes + shared grants, so approved
  escapes also unblock `edit`; its block reason names the approval tool.
- CLI `axiom root-guard list|approve <id>|reject <id>` with `--root`,
  `--state-dir`, `--json`, `--note`; registered in the command roster.
- Strict block-by-default; `INFRA_ALLOW_PREFIXES` (OS read surface, /tmp,
  axiom home, ~/.local, ~/.config, ~/.cache) is opt-in via
  `AXIOM_ROOT_GUARD_ALLOW`. Knobs: `AXIOM_ROOT_GUARD_ALLOW` / `_DENY` /
  `_STATE_DIR` / `_APPROVAL_TIMEOUT_MS`.

## Verification

- 81 new/extended tests, red-first, all green: extractor (14), scope (14),
  store (9), extension + approval tool (23), CLI (6), workspace (15 total,
  3 new escape tests).
- Floor: `./test.sh` from the worktree with `AXIOM_PROJECT_ROOT` unset —
  only the documented sandbox known-fails (4603 x4, 4685 x9 EXDEV,
  daemon-serialized-refine x1) plus two shard flakes that pass standalone
  (anthropic-oauth, kernel-rlm-heartbeat-skill). biome clean, tsgo clean.
- No live model/provider run (no API key in this sandbox) — recorded, not
  faked. The approval loop is unit-verified end to end (request -> wait ->
  decision -> grant -> retry passes).

## Follow-ups (recorded, not done)

- Gateway inline approve buttons (the gateway is single-threaded while a
  completion runs).
- Per-project escape config file (today: env vars + grants).
- Obfuscation-hardening of the shell path extractor (never claimed as
  confinement — ADR-0019 is the strict tier).
