# Handoff: Root guard v2 (ADR-0052)

What was done, what was verified, and how.

## Done

Issue #17, the last unshipped rung-3 step of the ADR-0014 anti-drift ladder:
path confinement for the freeform file tools plus a plain-English approval
loop. Branch `feat/root-guard` (pushed), worktree `.worktrees/root-guard`, cut from
main 2bbdc2f0e and integrated with origin/main (gh-tooling ADR-0050 +
gateway-resilience ADR-0051) at merge 6f50e9f3a.

- The root-guard extension gates `bash` and `ipython` on the `tool_call`
  seam: literal path tokens outside the project root block by default —
  strict block-by-default (issue #17 criterion a, literally). The
  `INFRA_ALLOW_PREFIXES` list (OS read surface, /tmp, axiom home, ~/.local,
  ~/.config, ~/.cache) is opt-in via `AXIOM_ROOT_GUARD_ALLOW`.
- Escapes: `request_root_access` files a plain-English request and waits
  (polling, abortable, 5 min default); the operator decides with
  `axiom root-guard approve|reject <id>`. Approvals persist as grants
  (idempotent — one grant line per request id) and unblock later calls,
  including `edit` (the workspace guard reads the same allow prefixes and
  grants and audits grant-use). A decided request leaves the pending board;
  a store failure fails closed with a plain reason.
- Never silently allowed: every block, request, decision, grant, and
  grant-use is appended to an audit JSONL under
  `<axiom home>/root-guard/<root-hash>/`.
- CLI `axiom root-guard list|approve|reject` registered in the command
  roster; CONTEXT.md Root guard term updated; ADR-0052 written (renumbered from 0051 when
  main's parallel sessions took 0050/0051).

## Verified

- Unit + mock: 81 new/extended tests, red-first, green. Cover: path
  extraction, scope classification, store round trips, approval tool
  (approve/reject/timeout/abort/deny-refusal), extension wiring
  (inert-unanchored, env parsing, grants, audit), workspace edit escapes,
  CLI.
- Floor on the worktree: `./test.sh` (AXIOM_PROJECT_ROOT unset) — only the
  documented sandbox known-fails (4603 x4, 4685 x9, daemon-serialized-refine)
  plus four standalone-passing shard flakes (daemon-supervisor-process x2,
  kernel x2); `npx biome check` clean for all feature files (two pre-existing
  biome errors in origin/main's gh-tooling files are not this feature's);
  `tsgo --noEmit` clean.
- NOT verified (honest): no live model/provider run in this sandbox; the
  gateway inline-approve UX is a recorded follow-up.

## How to try it

1. Anchor a run: `AXIOM_PROJECT_ROOT=<root> axiom` (or the gateway with
   `--project`).
2. Ask the agent to read `~/Documents/x` or `cat /etc/passwd` — both block
   (strict by default) and the agent offers `request_root_access`.
3. Approve from another terminal: `axiom root-guard list`, then
   `axiom root-guard approve <id> --root <root>`; the retried call passes.
4. Practical posture: `AXIOM_ROOT_GUARD_ALLOW=<paste INFRA_ALLOW_PREFIXES>`.
5. Strictness stays tunable per path with `AXIOM_ROOT_GUARD_DENY`.

## Next

Merge to main after review; recorded follow-ups: gateway inline approve
buttons, per-project escape config file, extractor obfuscation-hardening.
