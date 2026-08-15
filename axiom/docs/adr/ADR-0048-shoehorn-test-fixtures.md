# ADR-0048 — Shoehorn for test fixtures, type-level-only casts in hoisted callbacks

## Status
Accepted (2026-08-14)

## Context
Test files carried ~1,800 `as Type` and ~1,000 `as unknown as Type`
assertions to fake partial values (deep configs, protocol messages,
daemon state) and intentionally wrong data. `as`-casts are what the
team was trained not to write, must restate the target type, and need
double casts for wrong data. The repo adopted `@total-typescript/shoehorn`
in the four test packages (agent, ai, coding-agent, tui) to replace them.

Shoehorn's functions are runtime calls, though. `vi.hoisted` callbacks
and `vi.mock` factories run before the test module's own imports
initialize, so a shoehorn call there throws
`ReferenceError: Cannot access '__vi_import_0__' before initialization`
(the factory cannot see the import binding yet). Casts in those regions
must stay type-level-only.

## Decision

- Test code uses shoehorn: `fromPartial` for deep-partial fixtures,
  `fromAny<T, unknown>` for intentionally wrong or unknown data, and
  `fromExact` when a full object is wanted. Never in production code.
- `fromAny` always gets its two type arguments (its installed signature
  is `<T, U>` with no default), with `unknown` as the mock type.
- Inside `vi.hoisted` and `vi.mock` factories, no shoehorn calls. Use
  type-level-only forms instead: annotate the hoisted callback's return
  type (`vi.hoisted((): Shape => ({ ... }))`) or, for values that cannot
  satisfy the target shape at all (the standard vitest `as never`
  override idiom), keep an `as` cast. `importOriginal<typeof import(...)>()`
  is preferred over casting the result of `importOriginal()`.

## Consequences

- The only remaining `as` casts in tests are `as const` (unrelated),
  `as any` (separate smell cluster, tracked separately), and a small
  number of `as never` sites confined to hoisted mock callbacks where
  no runtime call can run.
- Adding shoehorn calls inside hoisted callbacks is a runtime crash;
  reviewers should flag them. The same TDZ constraint applies to any
  other imported runtime value called from a hoisted factory.
