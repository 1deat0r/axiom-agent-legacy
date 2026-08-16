# ADR-0094 — One browser URL-intake guard: evaluate_url_safety wired as the seam

Status: accepted
Date: 2026-08-16

## Context

The upstream merge (2026-08-16) restructured the browser URL guards into
`tools/url_safety.py` and added `evaluate_url_safety(url)` in
`tools/browser_tool.py` — a consolidated five-check guard (secret exfil,
sensitive query params, cloud-metadata floor, private addresses, website
policy). But the function was **dead code**: nothing called it, while
`browser_navigate` carried an 81-line inline near-duplicate of the same
checks, differing only by the hybrid-routing sidecar exemption (a private
URL routed to the auto-local Chromium sidecar never reaches the cloud
provider, so the sensitive-param and private-address checks must not fire
for it). This was candidate C3 of the architecture review, re-shaped by the
merge: adopt-and-wire instead of extract.

The design was grilled with the operator; all frontier decisions
operator-approved.

## Decision

1. **Adopt and wire.** `evaluate_url_safety(url, task_id=None)` becomes the
   single URL-intake guard. `task_id` feeds the navigation session key
   (None-safe), so the guard owns the sidecar exemption itself — "is this
   URL allowed for THIS navigation" is guard policy.
2. **`browser_navigate` crosses the seam.** The 81-line inline cluster is
   deleted; navigate calls the guard, returns its verdict verbatim, then
   re-derives the session key (`nav_session_key`, `auto_local_this_nav`,
   `effective_task_id`) for the backend mechanics — the guard owns the
   decision, navigation owns the mechanics.
3. **No other handler folds in this ticket.** `browser_snapshot` and
   `browser_vision` carry current-page revalidation guards (post-eval
   `location.href` re-checks) — a different contract from URL intake; they
   stay as-is.
4. **Interface**: dict verdicts unchanged (the existing guard suites are the
   characterization net); `None` = safe.

## Consequences

- One guard story: upstream's function is no longer dead, navigate's
  duplicate is gone (81 → 7 lines at the intake), and every future URL
  intake gets the five checks + the sidecar exemption by calling one
  function.
- Behavior is preserved exactly — the error shapes, check order, and the
  sidecar exemption semantics are the pre-change navigate logic, pinned by
  the existing suites (secret-exfil, ssrf-local, hardening, hybrid-routing)
  plus `tests/tools/test_browser_url_guard_seam.py` (8 tests, red first:
  the task_id signature, the exemption both ways, exact error shapes, and
  the navigate-crosses-the-seam wiring).
- The current-page revalidation guards in snapshot/vision remain a known
  separate surface — a future seam decision, not this ticket.
