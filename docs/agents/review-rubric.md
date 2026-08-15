# Merge gates (eval-first)

This file is the single source of truth for merge-gate reviews. It
replaces the numeric rubric (retired 2026-08-14) and the risk-classed
rubric (same day, superseded by this file).

Sources: OWASP AI Agent Security Cheat Sheet (2026, verified against
master 2026-08-15), Anthropic "Demystifying evals for AI agents" (Jan 2026),
LLM-as-judge research (CodeJudgeBench, the LLM-as-a-judge survey), and
CR-bench (NUS, March 2026) — the first executable benchmark of code review
agents, which measures reviews by tests, not by textual similarity.

## Principles

1. Evals are the gate. Every issue ships an executable eval: test files
   whose assertions encode the acceptance criteria and FAIL on the code
   before the change. The agent develops red-first against the eval.
   Merge requires: the eval green, the full ./test.sh floor clean except
   the documented sandbox known-fail allowlist, biome clean, tsgo clean.
   Reviewers run read-only by tool denial (Write/Edit disabled), not by
   convention.
2. LLM review is advisory. A reviewer may be asked for spec-quality
   critique, cross-cutting concerns, and claim spot-checks. It never
   issues a score and its verdict is never the authority for merging.
   CR-bench shows why: review agents pass 41.5% of executable review
   tests while 84% of their comments are still useful — the findings
   are worth reading, the verdicts are not worth obeying.
3. Findings must be falsifiable. Every reviewer finding names file and
   line plus a one-step reproduction (a test, a command, or a diff
   hunk). A finding the author cannot reproduce in one step is a false
   positive; drop it or relabel it as an observation. False positives
   are the failure mode that trains people to ignore reviews. A real
   finding is not argued in prose: it becomes a test in the eval, the
   same channel red-team findings use.
4. S-class changes ship a threat corpus. The issue must name at least
   five attack cases that fail on the old code (bypasses, forgeries,
   races). Red-team runs exist to add cases to the corpus; their
   findings become permanent tests. A one-off red-team report gates
   nothing by itself.
5. Multi-agent fan-out is isolated. Each child agent gets its own agent
   dir, its own kernel venv, no shared mutable auth files, and a budget
   cap. OWASP names cascading failures and denial-of-wallet as top agent
   risks; shared auth.json and shared venvs are how they happen here.
6. Humans gate high-impact actions only. Live wiring, security-posture
   changes, and irreversible actions need operator sign-off. This is the
   OWASP human-in-the-loop rule, not a review step.

## Risk classes

- S — security surface: path confinement, URL/DNS gates, sandboxing,
  transport receive, credential handling. Needs the threat corpus.
- A — core correctness: runtime, token accounting, cost ledger, session
  state. Needs a real-environment run of the core path in the eval.
- B — docs and tooling: audits, issue tooling, workflows.

## Close ritual (unchanged)

One capability, one ADR, one handoff. The audit comment on issue close
links the merge commit, the ADR, and the handoff, and states what was
verified and how (unit / real-environment / operator).
