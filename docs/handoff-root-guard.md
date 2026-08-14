# Handoff: Root guard v2 (ADR-0051)

What was done, what was verified, and how.

## Done

Issue #17, the last unshipped rung-3 step of the ADR-0014 anti-drift ladder:
path confinement for the freeform file tools plus a plain-English approval
loop. Branch `feat/root-guard` (commit d034adf10, pushed), worktree
`.worktrees/root-guard`, based on main 2bbdc2f0e.

- The root-guard extension gates `bash` and `ipython` on the `tool_call`
  seam: literal path tokens outside the project root block by default.
  Default infra set (OS read surface, /tmp, axiom home, ~/.local, ~/.config,
  ~/.cache) stays available; `AXIOM_ROOT_GUARD_STRICT=1` drops it.
- Escapes: `request_root_access` files a plain-English request and waits
  (polling, abortable, 5 min default); the operator decides with
  `axiom root-guard approve|reject <id>`. Approvals persist as grants and
  unblock later calls, including `edit` (the workspace guard reads the same
  allow prefixes and grants).
- Never silently allowed: every block, request, decision, grant, and
  grant-use is appended to an audit JSONL under
  `<axiom home>/root-guard/<root-hash>/`.
- CLI `axiom root-guard list|approve|reject` registered in the command
  roster; CONTEXT.md Root guard term updated; ADR-0051 written (took 0051 to
  avoid the semantic-color branch's ADR-0050).

## Verified

- Unit + mock: 72 new/extended tests, red-first, green. Cover: path
  extraction, scope classification, store round trips, approval tool
  (approve/reject/timeout/abort/deny-refusal), extension wiring
  (inert-unanchored, env parsing, grants, audit), workspace edit escapes,
  CLI.
- Floor on the worktree: `./test.sh` (AXIOM_PROJECT_ROOT unset) — only the
  documented sandbox known-fails plus two standalone-passing shard flakes;
  `npx biome check .` clean for all changed files; `tsgo --noEmit` clean.
- NOT verified (honest): no live model/provider run in this sandbox; the
  gateway inline-approve UX is a recorded follow-up.

## How to try it

1. Anchor a run: `AXIOM_PROJECT_ROOT=<root> axiom` (or the gateway with
   `--project`).
2. Ask the agent to `cat /etc/passwd` — it passes (infra); ask it to read
   `~/Documents/x` — it blocks and offers `request_root_access`.
3. Approve from another terminal: `axiom root-guard list`, then
   `axiom root-guard approve <id> --root <root>`; the retried call passes.
4. Strict mode: `AXIOM_ROOT_GUARD_STRICT=1 AXIOM_ROOT_GUARD_ALLOW=/tmp,...`.

## Next

Merge to main after review; recorded follow-ups: gateway inline approve
buttons, per-project escape config file, extractor obfuscation-hardening.
