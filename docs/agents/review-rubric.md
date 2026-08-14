# Review rubric

This file is the single source of truth for merge-gate reviews. The old
numeric rubric (Spec 4 / Quality 3 / Verification honesty 2 / Discipline 1,
approve >= 9.5) is retired: it rewarded spec compliance over spec quality,
rewarded honest disclosure of untested paths instead of closing them, and
its scores inflated. Reviews now use risk classes and hard gates.

## Risk classes

Assign one class per change, stated in the review brief:

- **S — security surface.** Path confinement, URL/DNS gates, sandboxing,
  transport receive, credential handling, anything on the tool-call seam.
- **A — core correctness.** Persistent runtime, token accounting, cost
  ledger, session state, gateway completion.
- **B — docs and tooling.** Audits, issue tooling, workflows, docs.

## Axes (PASS/FAIL each, no aggregate score)

1. Spec quality. The issue's acceptance criteria must be sufficient for the
   risk class. The reviewer challenges the spec itself; a spec gap is a
   finding even when the code matches.
2. Implementation. Purity, error handling, repo conventions (AGENTS.md),
   no `any`, erasable TS, `.js` specifiers.
3. Adversarial verification. The reviewer attacks the change: S-class gets
   bypass and forgery attempts (path escapes, marker forgery, allowlist
   holes, timeout races), A-class gets mutation and injection cases. The
   reviewer runs the attacks, not just reads the code. Mock-only
   verification of the core mechanism = BLOCK for S, and for A it must be
   compensated by a real-environment run of the core path.
4. Evidence honesty. Every claim in the agent report must be reproducible.
   An overclaim is a blocker, not a nit.
5. Discipline. Red-first tests, one ADR, one handoff, issue rituals,
   no stray files.

## Merge gates

- Zero blockers, every axis PASS.
- S-class extra gate: the ADR carries a threat-model paragraph naming what
  the change defends against and what it deliberately does not defend.
- S-class extra gate: live wiring or operator sign-off stays with the
  operator; no reviewer can substitute for it.
- Any S-class change that merged under the old rubric gets an adversarial
  re-pass at the next opportunity; findings become follow-up fixes.

## Reviewer rules

Reviewers stay read-only. They run the suites and their own attack cases.
The verdict file is the only channel back to the parent.
