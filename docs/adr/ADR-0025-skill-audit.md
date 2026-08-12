# ADR-0025: Skill security audit (skills_audit / skills_guard)

**Status:** accepted
**Date:** 2026-08-12
**Extends:** ADR-0024 (skill capture, procedural-memory skills)
**Implements:** the AST-level security audit half of the "skills that learn procedural memory" capability

## Context

ADR-0024 added the *capture* half of procedural-memory skills: turning a
flagged-reusable task into a validated SKILL.md. Once skills are captured and
shared (and, later, installed from a hub), Axiom must keep its safety ethic
intact when *running a skill that did not come from a trusted first-party
bundle*. Hermes ships `skills_ast_audit` + `skills_guard` for exactly this; this
ADR ports that guard.

The risk: a third-party skill is code that the agent loads into its environment
(a Python-backed skill installs into the persistent IPython kernel; markdown
skills carry shell instructions). Without a static screen, installing/running it
could execute arbitrary subprocesses, exfiltrate secrets, or mutate the
filesystem.

## Decision

A **skill security audit** (`packages/coding-agent/src/core/skill-audit/`) that
statically inspects a skill directory and derives a conservative verdict:

- **Python — AST level.** Each `.py` is parsed with the real `ast` module (a
  subprocess `python3` runs a bundled analyzer and returns JSON findings) and
  walked for: dynamic code (`eval`/`exec`/`compile`/`__import__`), dangerous
  calls (`os.system`, `subprocess.*`, `os.popen`, `shutil.rmtree`/`remove`/
  `unlink`, process exec), network egress (`socket`, `requests`,
  `urllib`/`httpx`/`aiohttp`, smtp/ftp/paramiko — reads warn, sends block),
  file mutation (`Path.write_text`, `unlink`, `rmdir`), secret reads
  (`os.environ`/`getenv`/`getpass`), and sensitive imports.
  When `python3` is absent the audit degrades to a structural scan plus a note.
- **JS** — structural scan: `eval`/`new Function`, `child_process` exec/spawn,
  `os.system`, network, `process.env`, fs writes, base64.
- **Shell / markdown fences** — structural scan: pipe-to-shell (`curl|sh`),
  destructive (`rm -rf /`), reverse shells (`bash -i`, `/dev/tcp`), privilege
  (`sudo`), listening netcat (block); network tools, `eval`/`$( )`, `pip/npm
  install` (warn).
- **Verdict** (`chooseVerdict`): any `block` -> **BLOCK**; else any `warn` ->
  **WARN**; else **ALLOW**.

**Surfaces:** `auditSkill(dir)` returns a `SkillAuditReport` (verdict, findings,
files scanned, ast-parsed list, notes); a reusable `chooseVerdict` policy; and a
CLI `axiom skill-audit <dir> [--json]` wired into `main.ts` after
`skill-capture`.

## Honest boundary (recorded, not faked)

- The audit is **static** and conservative. A benign network-egress skill (e.g.
  the bundled `websearch`) audits to BLOCK under the default rules. That is the
  intended posture: the guard targets *third-party* skills; first-party/bundled
  skills are allowlisted by the operator at run time. Auto-fed allowlists,
  sandboxing the audited process, and blocking-by-default install gating are
  follow-ups.
- Structural (non-AST) scans are best-effort literal scans and can false-positive;
  false-negatives in the pipe-to-shell family are the highest-severity risk they
  exist to catch.
- Wiring the guard into the actual skill *execution* path (the kernel install) is
  a follow-up; this ADR provides the reusable policy + CLI the runner can call.

## Consequences

- Third-party skills can be screened before they run; BLOCK verdicts stop risky
  code, WARN surfaces it for review, ALLOW passes clean skills.
- The guard reuses the core CLI pattern and is isolated in its own module
  (minimal blast radius: a few lines in `main.ts`).
- Fully unit-tested (12 tests), including the Python AST level and the graceful
  fallback when `python3` is unavailable.
