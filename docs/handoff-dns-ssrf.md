# Handoff — DNS-aware SSRF protection for the URL gate (issue #35, ADR-0057)

## What was done

Extended the ADR-0028 URL-safe fetch gate (`packages/coding-agent/src/extensions/security/url.ts`)
with DNS-aware SSRF protection, closing the recorded follow-up: named hosts were
previously allowed without resolution, so `http://intranet.corp/` passed even when
the name resolves to `10.0.0.5`.

- `checkUrlSafety` is now async and, for named http(s) hosts that pass the literal
  checks (malformed URL, scheme, credentials, SSRF-prone literals, loopback-patterned
  names), resolves A/AAAA records and classifies every resolved address with the same
  `isPrivateIPv4` / `isPrivateIPv6` range functions as the literal path. One private
  address among many public ones blocks the fetch.
- Resolution failure fails closed: resolver rejection (NXDOMAIN, timeout, generic
  error) and empty results both block, with a reason naming the host and the error
  code.
- Pure resolver seam: `HostnameResolver` on `options.resolver`; the default
  `makeDefaultResolver(timeoutMs, lookupFn?)` uses `node:dns` `lookup` (A + AAAA in
  one call) raced against a timeout (default 2000 ms), rejecting on lookup error,
  timeout, or an unclassifiable address family.
- `AXIOM_FENCE_ALLOW_HOSTS` allowlisted hosts skip resolution entirely (checked
  before the DNS stage).
- `checkSensitiveTool` is now async (the `tool_call` seam was already async), and the
  fence wiring threads `resolver` / `dnsTimeoutMs` from its options so tests and
  hosted callers can inject offline resolvers end to end. The first wiring test run
  caught a real gap here: the wiring rebuilt the options object for the gate and
  dropped the resolver, so the test hit real DNS (ENOTFOUND) — fixed by threading the
  two fields through.
- Scope honored: no always-on gate (still inert unless anchored), no DNS rebinding
  mitigation, no caching. DNS runs for http(s) only; extra allowed schemes keep the
  literal checks.

## Verification

- Red-first: wrote the DNS-aware tests first (29 url + 7 fence + 7 wiring); the red
  run showed 11 failures (makeDefaultResolver missing, private resolutions not
  blocked), then implemented to green.
- Targeted suites: `security-url` + `security-fence` + `security-wiring` = 46/46
  green.
- `npx biome check .`: 1108 files, no errors; only the 2 pre-existing
  telegram-transport info-level notes remain. `npx tsgo --noEmit`: clean.
- Full floor `./test.sh` (AXIOM_PROJECT_ROOT and fence env scrubbed): 5269 passed /
  16 failed. The 16 are: 4603-worker-recovery x4 + 4685-daemon-client-modes x9
  (documented EXDEV sandbox known-fails), daemon-serialized-refine-process x1
  (documented), daemon-supervisor-process x1 and ipython-bootstrap x1 (real-process /
  kernel flakes under parallel load). ipython-bootstrap passes standalone 6/6.
  daemon-supervisor-process fails at the BASE commit (473516062) too — proven by
  running it in a clean detached worktree at base, where it failed 2 tests — so it is
  pre-existing and environmental (this shared box is under heavy parallel load), not
  a regression from this change. A later floor run put the flake count elsewhere
  (kernel suites), all of which pass standalone (21/21).
- Live DNS smoke (real network, via tsx against the source module): example.com
  resolved to public A/AAAA and was allowed; a nonexistent `.invalid` host failed
  closed with the ENOTFOUND reason; the default resolver returned both families.

## Verified vs mocked vs not done

- Verified with unit tests (offline, injected resolvers): all acceptance criteria.
- Verified live: the default node:dns resolver path against real DNS.
- Mocked: `node:dns/promises` lookup in one unit test (`vi.mock`) to prove the default
  resolver uses node:dns with `{ all: true }` offline.
- Not done (recorded follow-ups in ADR-0057): DNS rebinding mitigation, a caching
  layer, an always-on URL gate for non-anchored runs.

## Follow-up — red-team fixes and S-class threat corpus (2026-08-14)

The adversarial review of the merged gate (/tmp/axiom-worktrees/dns-ssrf-redteam.md)
found two classifier bugs; this branch fixes both and ships the S-class threat
corpus the merge-gate rubric requires (docs/agents/review-rubric.md section 3).

- Fixed: the ::ffff:0: prefix form. The WHATWG URL parser rewrites
  ::ffff:0:127.0.0.1 to ::ffff:0:7f00:1. decodeHexV4 misparsed the three-group
  tail ("0:7f00:1" -> "0.0.1"), so the gate allowed the form. isPrivateIPv6 now
  expands a compressed IPv6 into eight hextets and decodes the two hextets
  after the ::ffff:0: prefix; a private embedded IPv4 blocks.
- Fixed: IPv4-compatible ::/96. ::127.0.0.1 becomes ::7f00:1 after URL parsing;
  the classifier had no ::/96 rule and allowed it. The whole ::/96 prefix is
  now classified private for defense in depth (BSD/Windows translate the tail;
  Linux does not today). No legitimate public address lives in the reserved
  prefix, so the false-positive cost is zero.
- Kept safe: every safe verdict from the report stays safe (v4-mapped forms,
  weird literals, nip.io, mixed answers, empty results, timeout fail-closed,
  allowlist exact-match). The known ffff: over-block for some public addresses
  is preserved (safe direction).
- New: test/extensions/security-attack-corpus.test.ts — 15 offline corpus cases
  (each case: name, exact input from the report, expected verdict), with the
  documented-exposure case below.
- Left for #43: the DNS rebinding TOCTOU. The gate resolves once and the fetch
  resolves again; nothing pins the answers. One corpus case asserts the current
  single-resolution behavior with a pointer to #43 (ADR-0066); update it when
  #43 ships.
