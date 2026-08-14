# ADR-0066: DNS rebinding pinning for the URL gate

**Status:** accepted
**Date:** 2026-08-15
**Extends:** ADR-0028 (security fence, URL-safe fetch half) and ADR-0057
(DNS-aware SSRF protection)
**Closes:** issue #43 (the ADR-0057 "remaining follow-ups" rebinding item)

## Context

ADR-0057 closed the DNS-aware SSRF gap: named http(s) hosts are resolved and
every resolved address is classified; private answers block. Its honest,
recorded limit: resolution is point-in-time. The gate resolves once, the
fetch resolves again, and nothing pins the first answer to the second — the
classic DNS rebinding TOCTOU. The red-team live repro (2026-08-14,
/tmp/ssrf-redteam/rebinding.mts) proved it: an attacker resolver answered
`8.8.8.8` for the gate (ALLOW) while the system resolver mapped the same
hostname to `127.0.1.1` for the fetch, which then read
`LOOPBACK-SECRET-VIA-REBIND` from a loopback server. The same window lets a
public URL redirect (302) to a loopback/private target that never passed the
gate (red-team finding, recorded on #35).

This is the classic SSRF-adjacent race: the checked address must be the
connect address.

## Decision

The gate now re-resolves at connect time and re-checks, and ships a
gate-owned pinned fetch. Two layers:

1. **Connect-time re-resolution (in the gate).** For a named http(s) host
   that passes the literal checks and is not allowlisted,
   `checkUrlSafetyPinned` resolves TWICE: the check, then a connect-time
   re-resolution that is re-classified with the same pure range functions.
   A private/reserved address in the second answer blocks (reason names the
   address and "possible DNS rebinding"); a rejection or an empty second
   answer fails closed. A stable public host passes both phases and the
   second (freshest) answer becomes the pin. Multi-IP hosts stay allowed:
   both phases classify all-public sets, and reordering/growing a public
   pool does not block.
2. **Pinned fetch (`fetchPinned`).** The allow verdict carries the
   `PinnedResolution` (hostname + verified addresses). `fetchPinned` gates,
   pins, then fetches with the ORIGINAL Host header: the request options
   keep `hostname` (Host header, virtual hosting) and `servername` (TLS SNI
   and certificate verification — never disabled) while an injected
   `lookup` answers only the pin. The fetch never resolves the pinned
   hostname itself, so a resolver that flips after both gate phases has
   nothing to flip. Redirects are followed MANUALLY: every Location hop is
   re-gated (and re-pinned) before its connection, capped at
   `DEFAULT_MAX_REDIRECTS` (5); a public URL that redirects to a
   loopback/private target throws `UrlGateBlockError` before the second
   connection. All pinned addresses are offered to the connect, so
   legitimate multi-IP hosts keep their whole pool.

`checkUrlSafety` keeps its exact contract (`{block,reason} | undefined`) as
a thin wrapper over the new verdict, so the fence and every existing caller
are unchanged; the connect-time re-check flows through them automatically.
The default fetcher uses `node:http`/`node:https` with a `lookup` override —
no new dependencies, no undici version churn. `resolver`, `fetcher`, and
`gate` are injectable seams; the corpus stays offline.

## Alternatives considered

- **Re-check only (no pinned fetch).** Rejected as the whole fix: it shrinks
  the window but a flip after the second resolution still redirects the
  connection; the issue's title says close, not narrow.
- **Pin only (no re-check).** Rejected: the fence path never owns the fetch
  (the model fetches via freeform tools, ADR-0018), so the gate's own
  re-check is the only protection on that path; the two layers are
  complementary.
- **Pin into the global `fetch` (undici dispatcher).** Rejected: patching
  process-global fetch is a blast-radius hazard and undici's dispatcher
  options are version-sensitive; a gate-owned `fetchPinned` keeps the pin
  explicit and opt-in.
- **Require strict answer equality across the two resolutions.** Rejected:
  round-robin DNS legitimately returns different (all-public) sets per
  query; classifying each answer independently is the safe rule that does
  not break those hosts.
- **Cache results.** Still rejected (ADR-0057 stance): a caching layer has
  its own staleness/revalidation hazards and would reintroduce a
  stale-answer window; recorded follow-up.

## Consequences

- On an anchored run, a named http(s) fetch now costs two resolutions
  (check + connect-time) instead of one; each keeps the ADR-0057 timeout
  race so a hung resolver still fails closed.
- The rebind flip, IPv6 flip, mixed-answer flip, and connect-time resolver
  failure/emptiness are permanent corpus cases in
  `test/extensions/security-attack-corpus.test.ts` (updated from the
  exposure case that asserted the old single-resolution behavior), plus
  pinned-fetch fake-socket cases (fresh-resolution-ignored, redirect
  re-gate, port/Host preservation, TLS servername) and a dedicated unit
  suite `test/extensions/security-fetch-pinned.test.ts` with one real
  loopback socket round-trip.
- `fetchPinned` is a gate-owned http(s) primitive (GET, buffered body). It
  is opt-in for egress tools; the fence continues to block/deny tool calls
  and does not force its use. Freeform `bash`/`ipython` stay the ADR-0019
  OS-sandbox tier.
- Remaining follow-ups (honest, not faked): a caching layer, an always-on
  URL gate for non-anchored runs, and pin adoption by concrete egress tools
  when one ships.
- CONTEXT.md's Security fence entry drops the rebinding _Avoid_ line and
  records the mitigation; ADR-0057 carries the closure note.
