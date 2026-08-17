# Axiom — Release Notes

Last three commits on `main` (57dfbd7 → 814cfbf):

- **Landing page ships** — one-page Decide/Learn site on the real brand
  (evergreen + mint, monospace-led): hero, the problem, the spine
  (cost-visible + spend-capped), sovereignty, and a founder's-tier pre-sell CTA.
- **Demo transcript is live-captured, not fabricated** — the landing embeds a
  real session with its cost footer and cap notice; copy is backed by verified
  behavior only, no invented metrics or testimonials.
- **Plugin toolsets no longer flagged as unknown at init** — `validate_toolset`
  now runs idempotent plugin discovery and re-checks before warning, so an
  enabled plugin toolset like `axiom` (native-store-bridge) stops throwing a
  spurious warning at every chat start.
- **Spend cap still enforced** — the fix was live-verified: the unknown-toolset
  warning is gone and the cap still trips as before.
- **Session 13 handoff recorded** — grill → ship the story → three engine
  fixes, with what was done, what was verified, and how (never blurred).
