# Handoff — Security fence (URL-safe fetch + sensitive-tool fence)

**Branch:** feat/security-hardening (worktree .worktrees/security-hardening), based on main b31341e77.
**ADR:** ADR-0028.

## What was done
Extended the anchored-run tool seam (ADR-0014 rung 3) with two pure gates, in a
new `src/extensions/security/` module, registered in `builtInExtensions`:

- **URL-safe fetch** (`url.ts`): `checkUrlSafety` blocks malformed URLs,
  non-http(s) schemes, credential-bearing URLs, and SSRF-prone host literals
  (loopback/private/link-local/ULA/v4-mapped IPv4+IPv6, plus `localhost`,
  `*.localhost`, `*.local`). No DNS; arbitrary named hosts are allowed (recorded
  follow-up).
- **Sensitive-tool fence** (`fence.ts`): `checkSensitiveTool` runs the URL gate
  on any `url`-bearing tool and enforces an opt-in approved-tool ladder
  (`sensitiveTools` vs `approvedTools`).
- **Wiring** (`index.ts`): `createSecurityFence` is inert unless anchored
  (`AXIOM_PROJECT_ROOT`, shared with the root guard); env hatsches
  `AXIOM_FENCE_ALLOW` (approved tools) and `AXIOM_FENCE_ALLOW_HOSTS` (allowed
  URL hosts).

## What was verified, and how
- **Unit (pure):** `url.ts` 13 tests (private-IP v4/v6 classification, scheme,
  credentials, SSRF literals, hostname patterns, allowlist, extra schemes).
- **Unit (pure):** `fence.ts` 9 tests (url extraction, egress gate, approved-tool
  ladder, opt-in default).
- **Wiring (fakePi harness, workspace pattern):** `index.ts` 6 tests — blocks
  unsafe fetch when anchored, allows safe fetch, blocks sensitive tool unless
  approved, inert without anchor, back-compat passthrough, host-allowlist escape.
- **Floor:** companion — `npx biome check .` clean, `npx tsgo --noEmit` clean,
  full `./test.sh` (below).
- Red-first confirmed: each test file failed on its missing module before
  implementation (they still fail if the gate is removed).

## Follow-ups (honest, never faked)
- DNS-aware SSRF host resolution (arbitrary named hosts today).
- Always-on (non-anchored) URL gate variant.
- Interactive write approval prompt (config allowlist carries the escape today).
- Path security, threat patterns, skill provenance gate, tool-output limits.
- Freeform `bash`/`ipython` confinement remains the ADR-0019 OS tier.
