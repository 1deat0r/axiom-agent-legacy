# Security fence — running log (Loop v2)

Model: coding agent (axiom) · base main b31341e77 · worktree .worktrees/security-hardening · branch feat/security-hardening

- L0 preflight: scanned AGENTS.md/SOUL.md/CONTEXT/ADRs 0014/0018/0019/0024-0027; read workspace guard.ts + its fakePi test; confirmed no fetch/web tool exists in coding-agent today; builtInExtensions only consumed in main.ts (no count-asserting test) -> adding an extension is low-blast-radius. Conventions: vitest via node_modules/vitest cli, fakePi harness, {block,reason} seam, inert-unless-anchored, ADR+handoff+summary ritual. Base = main (has up to ADR-0027) -> new ADR-0028.
- L0 note: no separate external review sub-agent (daemon disabled, ADR-0015) -> self-posed skeptic reviewer, recorded transparently (same as prior features).
- L1 plan v1 written (goal, 6 steps, test strategy, risks). Self-review -> 2 weaknesses found.
- L2 self-review weaknesses found (>=2):
  W1 (Circularity/Fit) sensitive-tool fence default set was undefined/circular vs the URL gate. Fix: fence = configurable approved-tool ladder; built-in sensitive default = [] (opt-in, inert until an operator names tools) so we never over-claim fencing bash/ipython (ADR-0018 freeform stance). URL gate is the always-on egress piece.
  W2 (Risk) named-host SSRF bypass must be stated as a real boundary: literal IPs + loopback-patterned hostnames blocked; arbitrary hostnames ALLOWED (no DNS) — recorded limitation, DNS-resolution the follow-up. Honest direction.
  W3 (Testability) must prove WIRING, not just pure funcs: handler-level tests through fakePi invoking the real tool_call handler + inert-without-anchor test.
- L3 external review (self-posed skeptic, daemon disabled): r1 DENIED 84/100 -> fixed 3 citations (ADR documents DNS boundary + approved-tool ladder operator story; reason names specific unsafe property; back-compat passthrough test). r2 94/100 APPROVED.
- IMPL starts.
- IMPL green: url 13, fence 9, wiring 6 = 28/28; biome clean (999 files); tsgo --noEmit clean (root + coding-agent).
- Floor ./test.sh: 14 failed / 4544 passed / 59 skipped. The 14 = ONLY documented sandbox known-fails (daemon-serialized-refine 1, 4685-daemon-client-modes 9 EXDEV, 4603-worker-recovery 4 EXDEV). Passed grew 4516+28(new)=4544 -> no regressions.
- Docs: ADR-0028, CONTEXT term, handoff-security-fence.md written.
- Impl self-review: all plan items present; 28/28 green and assert real behaviour; no leftover TODOs/debug; edge cases covered. Fixed 1 clarity wart (stray AXIOM_PLACEHOLDER in a test name). biome+tsgo clean.
