# Round-2 synthetic-user acceptance — re-testing the fixes

Three NEW personas (distinct from round 1) re-tested the surfaces the
round-1 findings fixed. Journeys:
`packages/coding-agent/test/acceptance/personas-round2.test.ts` (all green).

## Persona reviews

### Nadia (non-technical budget owner)
"Last time the cap meant editing a file — I hated that. Today I set the cap
with `/cap 0.75`, checked it with `/cap` (it even showed me the headroom
against my session and lifetime), hit the cap mid-run and got a message
that told me what to do instead of leaving me staring, and cleared it with
`/cap none`. I never opened a file. This is what I asked for."

### Sam (ops engineer)
"I flooded memory past the cap and every over-cap add told me it evicted
one stale entry — no more silent data loss, I can audit the fade. And the
footer names the active profile at run start, so I can't confuse my SRE
profile with anything else. Both gaps I complained about are closed."

### Lena (client onboarder)
"Creating a profile now tells me the next two steps — `--profile acme` and
`/login` — so a fresh profile isn't a dead end. And `/cost` with five
models shows me the top rows, the cap line, and an honest '+2 more models'
instead of hiding the rest. I know exactly what I'm looking at."

## Verdict

All six round-1 findings verified closed by new users through the real
surfaces. The five-fix plan (approved by the independent expert after one
deny/revise cycle) resolved every reported finding; no new findings
surfaced in round 2.

Cycle record: steps 1-2 (personas + reviews) in `personas-round1.test.ts`
+ this file; step 3 (synthesis) and step 4 (plan v1) in `round1.md`;
step 5 (independent expert review: DENY v1 -> APPROVE v2) recorded on the
plan revisions; steps 6-7 (implement + test) in the ledger/memory/profile
fixes (commit 4b3ad1345); step 8 (new users) in `personas-round2.test.ts`.
