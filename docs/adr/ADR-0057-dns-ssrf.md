# ADR-0057: DNS-aware SSRF protection for the URL gate

**Status:** accepted
**Date:** 2026-08-14
**Extends:** ADR-0028 (security fence, URL-safe fetch half)

## Context

ADR-0028 shipped the URL-safe fetch gate as a pure, sync module that classifies
host LITERALS: loopback / private / link-local / ULA / v4-mapped IPv4+IPv6, plus
loopback-patterned hostnames (`localhost`, `*.localhost`, `*.local`). Its honest
boundary, recorded at the time: "arbitrary NAMED hostnames are allowed —
proving a name resolves to a private address requires DNS... DNS resolution is
a documented follow-up." A fetch of `http://intranet.corp/` passed the gate even
when that name resolves to `10.0.0.5`: the gate could not see the address.

This is the classic DNS-aware SSRF gap: an attacker (or a drifting agent) needs
only a name, not an IP literal. The follow-up is due.

## Decision

`checkUrlSafety` gains an async DNS stage (it becomes `Promise`-returning, as do
`checkSensitiveTool` and the fence wiring, which already runs on the async
`tool_call` seam). The flow for a named host:

1. Literal checks run first, unchanged: malformed URL, scheme allowlist,
   embedded credentials, SSRF-prone IP literals, loopback-patterned hostnames.
   IP literals and loopback-patterned names are classified WITHOUT DNS (the
   address is already known / the name is unsafe by pattern).
2. An allowlisted host (`allowHosts` = `AXIOM_FENCE_ALLOW_HOSTS`) returns
   allowed before any resolution — the hatch skips DNS entirely.
3. For named http(s) hosts, an injectable resolver resolves A/AAAA records and
   EVERY resolved address is classified with the same pure range functions as
   the literal path (`isPrivateIPv4` / `isPrivateIPv6`): loopback, private,
   link-local, ULA, v4-mapped, CGN. One private address among many public ones
   blocks the fetch.
4. Resolution failure FAILS CLOSED: resolver rejection (NXDOMAIN, timeout,
   resolver error) and an empty result both block, with a reason naming the
   host and the error code.

The resolver is a pure seam (`HostnameResolver`), injectable via
`options.resolver`, so unit tests stay offline. The default resolver
(`makeDefaultResolver`) uses `node:dns` `lookup` (getaddrinfo, A + AAAA) raced
against a timeout (`dnsTimeoutMs`, default 2000ms) so a hung resolver still
fails closed instead of blocking a tool call forever. `lookup` (the OS
resolver) is chosen over `dns.resolve4/resolve6` deliberately: it follows the
system resolver order and returns both families in one call.

DNS runs for http(s) schemes only. Extra allowed schemes (operator opt-in via
`allowedSchemes`, e.g. ftp) keep the literal checks and skip resolution — the
gate's fetch surface is http(s), and narrowing the new network dependency keeps
blast radius small.

## Alternatives considered

- **Keep the gate sync; classify names by pattern only.** Rejected: this is the
  status quo; `intranet.corp` stays invisible to the gate.
- **Resolve with `dns.resolve4` + `dns.resolve6`.** Rejected: two lookups, a
  `dns.Resolver` instance per call, and no system-resolver order; `lookup`
  returns both families at once.
- **Resolve every allowed scheme.** Rejected: non-http(s) schemes are an
  operator escape hatch, not the fetch surface; resolution there adds a network
  dependency with no SSRF payoff.
- **Cache results.** Rejected for this step: caching is a performance layer
  with its own staleness/revalidation hazards; recorded follow-up.
- **Always-on gate (non-anchored runs).** Rejected: ADR-0028 already recorded
  this as a later step; unchanged here.

## Consequences

- On an anchored run, a fetch of a named http(s) host now requires a DNS
  resolution that returns at least one public address. Offline or
  resolver-broken anchored runs block such fetches (fail closed) unless the
  host is allowlisted; this is the accepted trade for closing the SSRF gap.
- The URL gate is no longer a pure sync module: `checkUrlSafety`,
  `checkSensitiveTool`, and the `tool_call` fence handler are async (the seam
  was already async, so no consumer changes beyond `await`).
- The fence wiring threads `resolver` / `dnsTimeoutMs` from its options so
  hosted tests can inject offline resolvers end to end.
- Remaining follow-ups (honest, not faked): DNS rebinding mitigation
  (resolution here is point-in-time), a caching layer, and an always-on URL
  gate for non-anchored runs.
- CONTEXT.md's Security fence entry drops "pending DNS follow-up".

- Red-team follow-up (2026-08-14): the adversarial review of the merged gate
  found two classifier bugs; both are fixed here. Bug 1: the ::ffff:0: prefix
  form. The WHATWG URL parser rewrites ::ffff:0:127.0.0.1 to ::ffff:0:7f00:1.
  decodeHexV4 misparsed the three-group tail, so the gate allowed the form.
  The classifier now decodes the two hextets after the ::ffff:0: prefix and
  blocks a private embedded IPv4. Bug 2: IPv4-compatible ::/96 addresses.
  ::127.0.0.1 becomes ::7f00:1 after URL parsing; the gate allowed it. The
  whole ::/96 prefix is now classified private for defense in depth
  (BSD/Windows translate the tail; Linux does not today). The fixes ship the
  permanent S-class threat corpus test/extensions/security-attack-corpus.test.ts
  (docs/agents/review-rubric.md section 3): 15 offline cases from the red-team
  report, with regression cases for every keep-safe verdict (nip.io, weird
  literals, mixed answers, empty results, timeout fail-closed, allowlist
  exact-match). The DNS rebinding TOCTOU (point-in-time resolution, no
  pinning) stays a documented exposure and is now issue #43 (ADR-0066); one
  corpus case asserts the current single-resolution behavior and must be
  updated when #43 ships.
