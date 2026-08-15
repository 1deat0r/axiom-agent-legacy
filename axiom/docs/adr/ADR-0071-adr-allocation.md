# ADR-0071: ADR allocation — reserve at create, verify at merge

Status: accepted
Date: 2026-08-15

## Context

Decisions live in `docs/adr/` as numbered records (`ADR-00NN`), and the
number is the registry's primary key: it appears in CONTEXT.md terms, issue
titles, commit messages, and handoffs. The repo runs parallel agent sessions
on isolated branches, and each branch allocated its ADR number at write
time. Parallel branches cannot see each other's ADR files, so the allocation
collided three times in a week: ADR-0047 (semantic color vs. stream bubble
rollover), ADR-0048 (shoehorn fixtures vs. git guard, renumbered to 0049),
and ADR-0067 (read tool, renumbered to 0069 — the stall watchdog had merged
with 0067 first). Each collision forced a renumber cascade across files,
titles, and references.

## Decision

ADR numbers are allocated in the issue tracker, never at branch time:

1. **Reserve at create.** An issue that needs an ADR claims the LOWEST free
   number (no file in `docs/adr/`, no other OPEN issue reserves it) at create
   time, written in the issue title as `(ADR-00NN)`.
2. **Verify at merge.** The merging agent checks the ADR file's number equals
   the issue's reservation before merging; a mismatch is fixed by renumbering
   the LATER reservation (file rename, title, all references) and noting it on
   the issue.
3. **Gaps stay gaps.** A freed number is never reused; the series only grows.

The rule lives in `docs/agents/issue-tracker.md` and the glossary terms
"ADR reservation" and "Renumber" in CONTEXT.md.

## Considered options

- **Free allocation at branch time** — rejected: branches cannot see each
  other's ADR files; this is the observed failure mode.
- **First-write-wins** — rejected: the merge order decides, so the number an
  issue advertised is not the number it ships; renumber churn is identical
  but unpredictable.

## Consequences

- An issue's number is stable from create to close; renumbering becomes the
  rare exception instead of the routine.
- The reservation check is cheap and mechanical: `ls docs/adr/` plus the open
  issue titles.
