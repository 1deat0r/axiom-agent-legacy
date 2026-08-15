# ADR-0018: Workspace root guard (ADR-0014 rung 3, tool seam)

**Status:** accepted
**Date:** 2026-08-12
**Extends:** ADR-0014 (anti-drift ladder, rung 3)
**Implements:** the tool-layer enforcement of project isolation

## Context

ADR-0014's drift ladder puts the load-bearing enforcement at rung 3: a
workspace root guard that wraps the file tools and blocks resolved paths
outside the project root. Before this ADR, `/projects` created directories
only — a completion child inherited the gateway's cwd and had no project
boundary, so cross-project drift was possible.

## Decision

A **workspace root guard extension** (shipped with the axiom built-ins) that
is **inert unless a run is anchored** to a project:

- **Anchor:** `axiom gateway --project <name>` resolves the project under the
  active profile's workspace (`<profileHome>/projects/<name>`), fails fast when
  it does not exist (mirrors the telegram-token rule), spawns the completion
  child with `cwd = projectRoot` and `AXIOM_PROJECT_ROOT` set.
- **Guard:** on `tool_call` for the structured `edit` tool, the resolved
  (realpath-normalized) target must be inside the project root or the call is
  blocked; the `{ block, reason }` becomes an error tool-result surfaced to the
  model (agent-loop.prepareToolCall), telling it to keep changes inside the
  root. Both root and target are realpath-normalized once (symlinked roots and
  symlinks whose target escapes are caught). New (not-yet-created) files
  inside the root are allowed; new files outside are blocked.
- **Inert default:** no `AXIOM_PROJECT_ROOT` means no-op, so ordinary `axiom`
  runs are unaffected (minimal blast radius, back-compat).

## Honest boundary (recorded, not faked)

`bash` and `ipython` are freeform — no string-level guard can reliably confine
a shell command. Confining them is the ADR's **OS-sandbox strict tier**
(bubblewrap/unshare mount namespaces per project root), a separate follow-up.
This increment pins the structured write tool and anchors cwd; it does not
pretend to confine freeform execution.

Block-by-default is deliberate (ADR-0014). A per-project **escape allowlist**
(approved external paths, e.g. a scratch dir) is a follow-up; today escaping
writes are denied with a reason.

## Lifecycle rule

One gateway process runs one `--profile` and, when anchored, one `--project`;
the guard reads the root at child boot. A project root thus corresponds to a
single writer process.

## Consequences

- `/projects` still creates/removes directories; `--project` binds one at boot.
- Cross-project **write** drift via `edit` is now impossible on an anchored run;
  `bash`/`ipython` confinement and the escape allowlist remain the follow-ups.
- CONTEXT.md gains Project + Root guard vocabulary.
