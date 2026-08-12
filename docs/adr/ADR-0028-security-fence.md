# ADR-0028: Security fence (URL-safe fetch + sensitive-tool fence)

**Status:** accepted
**Date:** 2026-08-12
**Extends:** ADR-0014 (anti-drift ladder, rung 3) and ADR-0018 (workspace root guard)
**Amplifies:** the prevention ladder (identity → context → root → process)

## Context

ADR-0014's anti-drift ladder puts the load-bearing enforcement at rung 3 (tool)
and ADR-0018 shipped the first rung-3 gate: a workspace root guard (realpath
containment for `edit`) plus the gateway sender allowlist. Hermes shows the full
fence ahead — approved-tool ladder, write approval, URL safety, path security,
threat patterns, a provenance gate on third-party skills, tool-output limits
(`tools/tirith_security.py`, `url_safety.py`, `approval.py`, `skills_guard.py`,
...). This increment ships the **first two rungs of that fence** on top of the
root guard, cheap and high-trust:

1. **URL-safe fetch** — a gate over any tool that carries a URL outward.
2. **Sensitive-tool fence** — an approved-tool ladder over a configurable set of
   sensitive tools.

`bash`/`ipython` are, as in ADR-0018, out of scope for a string-level fence: they
are freeform and belong to the OS-sandbox strict tier (ADR-0019). Write approval,
path security, threat patterns, the provenience gate, and tool-output limits are
recorded later steps, not faked here.

## Decision

A **security fence extension** (`packages/coding-agent/src/extensions/security/`,
shipped in the axiom built-ins) that is **inert unless a run is anchored** — same
philosophy as the workspace root guard — so ordinary `axiom` runs are unaffected.
On an anchored run its `tool_call` handler applies two pure gates:

- **URL-safe fetch** (`url.ts`): `checkUrlSafety(raw, opts)` parses the URL and
  blocks, with a plain-English reason surfaced to the model:
  malformed URLs; non-http(s) schemes (`file:`, `data:`, `javascript:`, `ftp:`,
  `gopher:`, ...) unless extra schemes are allowed; URLs embedding credentials
  (SSRF/credential-leak vector); and SSRF-prone host literals — loopback /
  private / link-local / ULA / v4-mapped IPv4+IPv6 and loopback-patterned
  hostnames (`localhost`, `*.localhost`, `*.local`). No DNS is resolved (a pure
  sync module); **arbitrary named hostnames are allowed**, and resolving them to
  catch private targets is an honest, recorded follow-up.
- **Sensitive-tool fence** (`fence.ts`): `checkSensitiveTool(name, input, opts)`
  first runs the URL gate on any tool whose args carry a `url` field (the egress
  half), then blocks any tool whose name is in the configured `sensitiveTools`
  set unless it is in `approvedTools`. The built-in sensitive set is
  **deliberately empty** (opt-in) — an operator names which tools are sensitive
  for a project; this avoids pretending a string-level fence confines freeform
  tools we cannot confine (ADR-0018 stance).

### Configuration
- Anchor: `AXIOM_PROJECT_ROOT` (shared with the root guard), or a deps.root in tests.
- `AXIOM_FENCE_ALLOW` — comma-separated approved tool names (escape hatch).
- `AXIOM_FENCE_ALLOW_HOSTS` — comma-separated allowed URL hosts (escape hatch).
- Options object for tests: `sensitiveTools`, `approvedTools`, `allowHosts`, `allowedSchemes`.

### Lifecycle
Same as ADR-0018: one gateway process runs one profile and, when anchored, one
project; the fence reads its config at child boot. A project root corresponds to
a single writer process.

## Alternatives considered

- **Always-on URL gate** (also guards non-anchored runs). Rejected: SSRF defense
  matters everywhere, but shipping it always-on would change ordinary `axiom`
  runs' behaviour and risk over-blocking legitimate local fetches; gating to
  anchored project runs keeps blast radius minimal and is reviewable, with an
  explicit allowlist escape. An always-on variant is a later step.
- **Guard `bash`/`ipython` string patterns.** Rejected (ADR-0018): freeform tools
  cannot be reliably confined by string checks; that is the ADR-0019 OS tier.
- **Interactive approval prompt.** Rejected for this step: approval needs an
  interactive surface and is nondeterministic to test; the config allowlist
  (`AXIOM_FENCE_ALLOW`) carries the escape today, with a real approval prompt a
  later step.

## Consequences

- On an anchored run, a fetch of an unsafe/SSRF URL is now blocked at the tool
  seam, and sensitive tools need approval — amplifying rung 3 without touching
  ordinary runs.
- `bash`/`ipython` confinement, DNS-aware SSRF host resolution, write approval,
  path security, threat patterns, the skill provenance gate, and tool-output
  limits remain documented follow-ups (never faked).
- CONTEXT.md gains Security fence vocabulary.
