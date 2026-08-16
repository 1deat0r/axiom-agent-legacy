# ADR-0088 — Axiom TUI identity as a skin, via a widened skin surface

Status: accepted
Date: 2026-08-16

## Context

Axiom runs the Hermes Ink TUI (`hermes --tui`). That TUI hardcodes three
Hermes identity strings a skin cannot reach: the `⚕` caduceus seal
(`theme.ts` `BRAND.icon`, remapped in `fromSkin` as a literal `d.brand.icon`),
the banner tagline "Nous Research · Messenger of the Digital Gods"
(`branding.tsx` `TAG_FULL`/`TAG_MID`/`TAG_TINY`), and the "· Nous Research"
model attribution (`branding.tsx`). A skin could recolor, rename, and re-logo
the TUI, but the seal, tagline, and attribution would still read "Hermes."
"Undoubtedly Axiom" is unreachable through the existing skin surface.

## Decision

1. **Widen the skin surface generically, not Axiom-specifically.** Add three
   optional branding tokens — `icon`, `tagline`, `attribution` — to
   `SKIN_BRANDING_TOKENS` (`apps/shared/src/skin.ts`), `ThemeBrand` +
   `fromSkin` (`ui-tui/src/theme.ts`), and the banner/session-panel renderer
   (`ui-tui/src/components/branding.tsx`). Each falls back to the Hermes
   default when unset, so existing skins are byte-identical. The status-bar
   seal (`appLayout.tsx`) reads the theme icon instead of a literal `⚕`.
   This is the footprint-ladder rule applied to theming: widen the generic
   surface; do not special-case Axiom in core.
2. **The Axiom identity is data, not code.** It ships as a *user* skin
   (`axiom`), the theme analogue of a plugin: evergreen-and-mint palette,
   `agent_name: Axiom`, `icon: ◈`, `prompt_symbol: ∴`,
   `tagline: "Sovereign agent · keeper of the garden"`,
   `attribution: Axiom`, an AXIOM ASCII `banner_logo`, and a `∴` `banner_hero`.
3. **Canonical copy under `axiom/`.** The skin's source of truth is
   `axiom/skin/axiom.yaml` (versioned in Axiom's layer); it is installed to
   `<profile>/skins/axiom.yaml` — the path Hermes actually resolves — and
   activated with `display.skin: axiom`. Mirrors how `SOUL.md` lives in both
   `axiom/` and the profile.

## Consequences

- The Hermes tree gains an additive skin surface (three optional string
  tokens + one seal-reference). Zero behavior change for the default and
  existing skins; merge friction is small and additive, covered by the
  standing session-start merge + regression-sweep routine.
- Remaining Hermes identity strings in the TUI are functional feature names,
  not brand, and are deliberately left: the "Hey Hermes" wake word, billing
  "Nous Research" copy, "update Hermes Agent" help text, and the `hermes-ink`
  idle-emoji frame.
- The TUI bundle is a build artifact (`ui-tui/dist/entry.js`, gitignored);
  the surface widening takes effect on the next `npm run build` + relaunch.
