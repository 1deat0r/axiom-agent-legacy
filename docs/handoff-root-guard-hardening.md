# Handoff — root guard hardening (red-team blockers B1-B7)

**Branch:** feat/root-guard-hardening (cut from local main 6e77a6bd7, which
carries the root-guard merge cca863432). **Worktree:** /tmp/axiom-worktrees/root-guard-hardening.
**Issue:** #17 (acceptance wording updated to the honest boundary; close
ritual intact). **ADR:** ADR-0052 amended with a "Hardening (2026-08-14)"
section + amended honest boundary; CONTEXT.md Root guard term updated.

## What was done

The adversarial red-team report (root-guard-redteam.md) found 7 blocker
families against the shipped root guard. Each was closed on the tool seam,
red-first, with a permanent attack corpus.

| Blocker | Fix | Evidence |
|---|---|---|
| B1 self-approval | store moved to operator-owned default `/var/lib/axiom-root-guard` (env override; never the axiom home); grants+decisions HMAC-signed, key created ONLY by the CLI (the guard never creates it), unsigned/tampered entries read as ABSENT; state dir + legacy `<axiom home>/root-guard` hard-denied (lexical AND realpath) on both seams, deny wins over allow/grant; agent no longer writes grants (CLI approve owns them); cd/chdir through variable/env targets blocks | corpus B1-1..3, PY-3/4/5, signing describe (forged grant line inert, tampered sig inert, forged decision absent, CLI-signed grant works, guard never creates the key, state dir denied under an allow prefix) |
| B2 slash-spelling | decode `\/` + ANSI-C `$'...'` before extraction; posture flip: obfuscation markers + no inside token → block with request_root_access pointer; `chr(47)`-family blocks outright; `$VAR/` paths and ipython home/env composition fail closed | corpus F1-1..10, PY-1/2, GAP-1/2, SYM-1/2 |
| B3 bare-root + trailing operand | destructive binary list (rm/chmod/chown/cp/find/shred/dd/mv/chroot) + bare-root `/` operand → block on the bash seam and `%%bash`/`!` ipython lines; division exemption untouched on the python seam | corpus F2-1..12; OK-8 (`cat / b`) still allowed |
| B4 edit tilde | decideEdit expands `~`/`~/` + strips `@` exactly like the edit tool (expandPath) before realpath; prefix matching uses the same expansion | corpus B4 describe (3 block cases + inside-root control) |
| B5 symlink chain | `ln -s "$(printf '\x2fetc')"` and `ln -s $HOME/...` caught by the B2 marker flip | corpus SYM-1/2 |
| B6 file:// URI | `file://` URIs extracted as their path part → normal gate | corpus F1-11 |
| B7 breadth | request_root_access refuses `/`, operator home, axiom home (operator-CLI-only) and caps 64 paths; CLI `list` shows active grants + flags unverified decisions | corpus B6 describe (3 refusals + positive control) |

Corpus: `test/extensions/root-guard-attack-corpus.test.ts` — 62 permanent
cases, exact red-team inputs plus documented positive controls
(division arithmetic, env introspection, inside-root reads, `cat / b`
trade-off).

## Verification

- **Red first:** corpus written against the pre-hardening tree: 42 failed /
  20 passed (every F1/F2/python/B1/B4/B6 hole red, plus pre-existing blocks
  green as controls). After the fixes the same file is 62/62 green. Output
  captured in /tmp/corpus-pre-fix.txt.
- **Suites:** all 7 root-guard/workspace suites green (166/166), including
  the new corpus and updated store/extension/workspace tests (store test now
  asserts unsigned/tampered lines are inert; the CLI-approve flow and
  decision-only flow are both covered).
- **Floor:** `./test.sh` from the worktree — full run; expect ONLY the
  documented sandbox known-fails (4603 x4, 4685 x9, daemon-serialized-refine
  x1). Any extra failure was verified standalone before treating as a
  regression (see report for the numbers).
- **Static:** `npx biome check .` clean (2 pre-existing telegram infos only),
  `tsgo --noEmit` clean.
- **No live-model verification in this sandbox** — recorded as such.

## Operator checklist (deployment)

1. Provision the store once: `sudo mkdir -m 700 /var/lib/axiom-root-guard &&
   sudo chown $USER /var/lib/axiom-root-guard`, or point
   AXIOM_ROOT_GUARD_STATE_DIR at an operator-owned dir in the gateway env.
   Until then, outside-path calls fail closed with the store-failure reason.
2. The legacy store at `~/.axiom/root-guard/` is now DENIED and its unsigned
   entries are inert (they cannot be trusted after B1). Delete it or leave
   it; re-approve what is still needed with the CLI.
3. Grants/decisions are signed with a key the CLI creates on first use; the
   agent process never creates or writes it. `axiom root-guard list` flags
   unverified decision files and shows active grants.

## What the operator still owns (honest residual)

- Confinement itself: the guard is drift protection on the tool seam; the
  ADR-0019 OS sandbox is the strict tier. Variable indirection without a
  slash suffix, `eval`-built paths, and multi-step compositions remain
  residual (recorded in ADR-0052's amended honest boundary).
- Lexical containment for freeform tools: a symlink that already exists
  inside the root can still point outside (the edit tool realpaths).
- On a single-uid deployment the agent can still erase the audit log or the
  store (fail-closed DoS) — it can never forge an allow. A different uid for
  the store or the OS sandbox closes that.
- The filesystem root, the operator's home, and the axiom home: no
  model-initiated request can ever grant them; only the operator CLI can.
