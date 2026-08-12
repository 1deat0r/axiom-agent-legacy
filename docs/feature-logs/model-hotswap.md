# Gateway /model hotswap — running log

Model: coding agent (axiom) · base main 2f07a9edf · worktree /tmp/axiom-model · branch feat/gateway-model-hotswap · ADR-0033

- Preflight: read SOUL.md/AGENTS.md/CONTEXT, ADR-0033, handoff-gateway-model-hotswap.md, and the gateway command/completion seams. Feature shipped in one commit 4229eabd1 (store + /model command + argv injection + 45 tests). This session: bring it to 13-08-2026 standards (floor green, docs complete, help discoverability).
- Standards audit found:
  A1 (correctness) FileActiveModelStore.load() dropped a provider-empty override (`{provider:"",model}` rejected by the `raw.provider` truthy check) — the ADR-documented "bare /model <model> keeps the profile's provider" path lost its override on the very next load(), and the gateway reloads per completion. Red test added -> failed -> fixed: only the model must be a non-empty string.
  A2 (sediment) clear() wrote `{}` to the override file instead of removing it (channel-index uses rmSync). Red test -> fixed: rmSync(force).
  A3 (discoverability) /model was missing from /help — the handoff's own "remaining" item. Red test -> fixed: /help now shows the active-model status line (when a store is wired) + /model usage lines; describeActiveModel exported from model.ts is the single status formatter.
  A4 (clarity) orphaned doc comment on sessionsDir in gateway/types.ts (displaced by the modelStore field) — restored to its field.
  A5 (sediment) formatActiveModel exported with no consumers — pruned.
- Tests: active-model 12, commands 15, gateway 10, completion 12 = 49/49 green (was 45 feature tests; +2 store round-trip/clear, +1 gateway bare-model threading, +1 help). Plus mermaid-transform 6/6.
- Docs: ADR-0033 status dated 2026-08-13; CONTEXT.md gained the "Model hotswap" term; this log; handoff refreshed.
- Floor: ./test.sh (scrubbed env) = 14 failed / 4649 passed vitest + tui 761/0 + ai 69/0. The 14 are ONLY the documented sandbox known-fails (daemon-serialized-refine 1, 4685-daemon-client-modes 9 EXDEV, 4603-worker-recovery 4 EXDEV). Two pre-existing main defects (not model-hotswap regressions) surfaced on the first floor run and are carried here as cherry-picks from feat/mermaid-render: the mermaid subgraph title-role/border-clip fix (55fe6d44a) and the tui markdown-transform vitest-import crash under node --test (1e223daf5). With them, the floor is green to the same standard as the last shipped features. biome clean; tsgo --noEmit clean.

## Remaining (honest)
- /model choices are validated by the CLI on the next completion ("try it and see"); a gateway-side catalog would drift from the CLI and stays out of scope.
- Live end-to-end model call (real API/auth) is operator-gated — the seam is proven (flags reach the spawned CLI) but no live completion ran here.
