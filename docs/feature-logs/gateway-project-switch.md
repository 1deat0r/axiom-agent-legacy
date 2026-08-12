# RUNNING LOG — gateway live project switching + /projects menu (loop v2)

- [preflight] Read AGENTS.md, gateway command/router/completion/transport code, existing tests. Repo: vitest, biome, tsgo; ./test.sh gate; ADR + handoff ritual; ADR next = 0031.
- [scope] Feature = live per-channel project switching (`/projects use <n>`) + friendly text menu; inline-keyboard menus deferred (separate transport slice).
- [plan] Written + self-reviewed: fixed W1 (effective-root threading in completion), W2 (stale-active clear), W3 (menu marker tested in both dispatch modes). All dims >=4/5.
- [review-plan R1] DENIED 82/100 (C3 F4 T3 R3 C3): composite key must drive INDEX too; cite cron-jobs.json not channel-index.json; missing switch-sequence test; rm traversal bug (rm ..) + stale composite entries. Fixed all 4; resubmitting.
- [review-plan R2] DENIED (mechanism gap): rm->add->use must not resume stale session; no mechanism specified. Fixed: ChannelIndex.removeWhere + ctx.dropProjectSessions wired into rm; test (g) added. Resubmitting.
- [review-plan R3] DENIED (session-file layer): deterministic FNV re-derives SAME id after rm; mapping reset != session reset. Fixed: per-project generation counter in store, key = ${channel}:${name}:${gen}. Plan-review cap reached (3 rounds); implementation review will re-verify cold.
- [implement] Branch feat/gateway-project-switch; step 1 store red tests.
- [step1 DONE] active-project.ts store + 6 tests green; committed.
- [step2 DONE] per-call projectRoot override + removeWhere; 23 tests green; committed.
- [step3 DONE] /projects menu + use + hardened rm + help; 21 tests green; committed.
- [step4 DONE] router wiring; full gateway suite 209 green; 2 real bugs caught by tests (predicate suffix, self-heal index drop). committed.
- [self-review] Full diff re-read: plan items all present (docs pending); tests behavioral; one dead export removed; edge cases covered. ./test.sh = only documented known-fails.
- [impl-review] APPROVED 96/100 (mutation-tested). Applied flagged risk: resolve-path validation of stored names (shared PROJECT_NAME_RE). Debugging caught a silent import-miss bug (biome-reordered import); fixed + test (h).
- [docs DONE] ADR-0031, handoff-gateway-project-switch.md, summary-gateway-project-switch.html (5.8 KB, from log only).
- [loop DONE] All 7 loop steps complete; branch pushed.
- [tui step2 DONE] interactive-mode wiring (menu open + relaunch); 43 tests green; committed (hook clean: tsgo 0 after transient baseline edits vanished).
