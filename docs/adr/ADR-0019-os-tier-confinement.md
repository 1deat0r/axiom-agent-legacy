# ADR-0019: OS-tier confinement for anchored runs (ADR-0018 strict tier)

**Status:** accepted
**Date:** 2026-08-12
**Extends:** ADR-0018 (strict tier), ADR-0014 (anti-drift ladder)
**Closes:** the ADR-0018 freeform `bash`/`ipython` escape

## Context

ADR-0018 pinned the structured `edit` tool but recorded an honest gap: `bash`
and `ipython` are freeform — no string-level guard can reliably confine a shell
command, so a model could write anywhere on the host through one of them. The
ADR named an **OS-sandbox strict tier** (bubblewrap/unshare mount namespaces)
as the follow-up. This ADR implements that tier.

## Decision

When a gateway completion is **anchored** to a project (`CliCompletionRunner`
`projectRoot` set — i.e. `axiom gateway --project <name>`), the **whole
completion child** is spawned inside a **bubblewrap** sandbox (an unprivileged
user-namespace + mount-namespace boundary, kernel-enforced, no root required):

- `--ro-bind / /` — the host is visible but **read-only**: no write anywhere
  outside the sanctioned writable surfaces.
- writable **bind-mounts** — the project root (the work area, also `--chdir`)
  and the persistent stores `AXIOM_HOME` (default `~/.axiom`: profiles, ledger,
  session) and the prime agent dir (`~/.prime`: kernel venv) are re-exposed
  writable.
- `--tmpfs /tmp /run /var` — writable scratch that is NOT the host's dirs.
- `--tmpfs <home>/.ssh .aws .gnupg .netrc` — **credential stores** are shadowed
  (unreadable). Deliberately NOT shadowed: `~/.local` (user CLIs incl. the
  Obscura web browser), `~/.config` (tool configs), `~/.cache` — hiding them
  would strip the agent's tooling and web research. That read exposure is the
  honest price of full capability; a per-project `shadowDir` override tunes it.
- `--proc /proc --dev /dev` — fresh namespace proc + minimal dev.

The freeform `bash` tool and the persistent ipython kernel are **subprocesses
of the child**, so they inherit the mount namespace and are confined by the
same single OS boundary — there is no string wrapping (that was the gap). The
child is marked `AXIOM_CONFINED=1` and the reply opens with `[sandbox-confined]`
for operator observability.

**Deployment shape:** confinement is applied exactly when anchored (matching
the guard's inert default); unanchored `axiom` runs are untouched. The host
home stays **readable** so axiom's own CLI / node_modules under `$HOME` still
execute — this is why there is no wholesale `--tmpfs <home>`.

## Fail-closed

If bubblewrap is absent (or the sandbox cannot be established) an anchored run
**fails closed** with a clear message — install bubblewrap, set `AXIOM_BWRAP`,
or run without `--project`. An anchored run never falls back to unconfined.

## Honest boundary (recorded, not faked)

- `--ro-bind / /` keeps the host **readable**; only the listed secret dirs are
  shadowed. A **read-minimal allowlist** (bind only the dirs a project needs,
  shadow everything else) is a documented follow-up.
- **Network is inherited** (no `--unshare-net`) — deliberately so agents can do
  web research, fetches and searches inside a project. Network isolation is
  therefore **opt-in per project, off by default**; it is not a default hardening.
- The workspace **root guard (ADR-0018)** remains as belt-and-suspenders for
  the `edit` tool inside the sandbox.
- Not yet operator-live verified end-to-end with a real model completion (no
  provider key in this run); the OS boundary itself is proven by the real-bwrap
  integration test (writes refused, secrets shadowed, project writes persist).
  Tradeoffs to make explicit per project: shadowing `~/.ssh` blocks ssh-key git
  push by default (open it via `shadowDir` when the operator wants it); web
  research works (network inherited, tool dirs readable).

## Consequences

- An anchored run can no longer write outside its project root by ANY tool,
  including freeform `bash`/`ipython` — the last ADR-0018 escape is closed at
  the OS tier.
- Requires `bwrap` + unprivileged user namespaces on the operator host
  (present on the dev host; fail-closed error otherwise).
- CONTEXT.md gains Sandbox / confinement vocabulary.
