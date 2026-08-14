# Handoff: DNS rebinding pinning for the URL gate (issue #43)

**Branch:** feat/rebind-pinning
**ADR:** ADR-0066-dns-rebinding-pinning
**Issue:** #43
**Date:** 2026-08-15

## What was done

Closed the DNS rebinding TOCTOU in the URL gate (ADR-0028 + ADR-0057) two
ways, per the issue's preferred design:

1. **Connect-time re-resolution and re-check (in the gate).**
   `checkUrlSafetyPinned` resolves a named http(s) host TWICE — the check,
   then a connect-time re-resolution re-classified with the same pure range
   functions. A private/reserved address, a rejection, or an empty second
   answer blocks with a reason naming the address and "possible DNS
   rebinding". `checkUrlSafety` keeps its exact `{block,reason} | undefined`
   contract as a wrapper, so the fence and every existing caller are
   unchanged (the re-check flows through them automatically).

2. **Gate-owned pinned fetch (`fetchPinned`).** The allow verdict pins the
   verified connect-time addresses. `fetchPinned` gates, pins, then connects
   with the ORIGINAL Host header: request options keep `hostname` (Host
   header, virtual hosting) and `servername` (TLS SNI + certificate
   verification, never disabled) while an injected `lookup` answers only the
   pin — no fresh resolution for the fetch to be flipped. Redirects are
   followed manually and every Location hop is re-gated and re-pinned before
   its connection (cap 5 hops, `UrlGateBlockError` on block or cap). All
   pinned addresses are offered to the connect, so multi-IP hosts keep their
   pool. Default fetcher uses `node:http`/`node:https` with a `lookup`
   override — no new dependencies.

## What was verified and how

- **RED evidence (unit):** before the source change, with only the test
  files in place, `security-attack-corpus.test.ts` ran 23 tests with 9
  failures — every new attack case failed on the old code. The rebind-flip
  case failed with `AssertionError: expected undefined to be true` (the old
  gate ALLOWED the public-first/loopback-second flip). The fetch-pinned
  cases failed at import (module did not exist). The 14 pre-existing corpus
  cases stayed green.
- **GREEN (unit):** corpus + fetch-pinned suites 35/35; full security suites
  (`security-url`, `security-fence`, `security-wiring`,
  `security-attack-corpus`, `security-fetch-pinned`) 81/81. `tsgo --noEmit`
  clean; `biome check .` clean except the 2 pre-existing documented
  telegram-transport infos.
- **LIVE probe (real sockets, no public network):** a script mirroring the
  red-team repro — attacker resolver answers 8.8.8.8 then 127.0.0.1 — now
  gets BLOCK from the gate with exactly 2 resolver calls (previously ALLOW
  with 1). A second probe ran `defaultPinnedFetcher` against a real loopback
  server pinned under a fake hostname: status 200, body round-tripped, and
  the server saw `Host: pinned-demo:9981` — the connection went to the pin,
  the Host header kept the original hostname.
- **Mocked:** all corpus/fetch-pinned fake-socket cases inject the
  `resolver`/`fetcher`/`gate` seams; no case reaches the public network.
- **Not done (recorded follow-ups):** result caching, an always-on URL gate
  for non-anchored runs, pin adoption by a concrete egress tool when one
  ships, and live TLS verification against a real certificate (the
  `servername`/`rejectUnauthorized` preservation is unit-asserted, not
  live-tested).
- **Not run here:** the full `./test.sh` floor (parent runs it at merge
  time); the known sandbox EXDEV suites (4603/4685) are expected known-fails.

## Threat corpus (S-class, docs/agents/review-rubric.md section 3)

All in `test/extensions/security-attack-corpus.test.ts` (the exposure case
that asserted the old single-resolution ALLOW now asserts the BLOCK):

1. rebind flip — public for the check, loopback at connect time -> BLOCK
2. IPv6 rebind flip — public v6 for the check, ::1 at connect time -> BLOCK
3. mixed answers — connect-time set gains fd00::1 -> BLOCK
4. connect-time re-resolution rejects / returns empty -> BLOCK (fail closed)
5. keep-safe — stable and round-robin multi-IP public hosts still ALLOW,
   pin carries the connect-time answer
6. fake socket — fetchPinned connects to the pin even when a fresh
   resolution would answer loopback (the live repro shape; fetch resolves
   zero times)
7. fake socket — redirect to a loopback literal is re-gated and BLOCKED
   before the second connection
8. non-HTTP port — pinned connect preserves the original port (9981) and
   Host header
9. TLS — servername stays the original hostname; rejectUnauthorized never
   disabled

Plus `test/extensions/security-fetch-pinned.test.ts` unit suite: pinning
lookup purity + fallback, request options, one real loopback socket
round-trip, `UrlGateBlockError`, redirect handling and cap.
