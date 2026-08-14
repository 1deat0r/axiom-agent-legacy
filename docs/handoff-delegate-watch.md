# Handoff: delegate journal and live watch (issue #48, ADR-0072)

## What was done

- Every delegate run (foreground single, foreground batch, background single,
  background batch) writes an append-only JSONL journal under
  `<agent-dir>/delegate-results/`. Records: start, assistant, tool, tool_done,
  turn, end. Caps: 2000 chars per assistant record, 300 per tool args record.
- `RpcDelegateBridge` gained an optional `onEvent` hook. `createRpcClientBridge`
  forwards every helper agent event to it.
- Foreground results expose `journalFile` in `details`; background start blocks
  expose `journalFile` and print a `Watch live: axiom delegate watch <handle>`
  line.
- New CLI: `axiom delegate list [--json]` and `axiom delegate watch
  <handle|path> [--json]`. Watch is a live TUI (pi-tui ProcessTerminal, 250 ms
  poll) with q/Ctrl-C quit, up/down + j/k scroll, g/G jump, bottom pinning.
  Non-TTY prints a one-shot tail.
- Journal failures never fail the delegation (best-effort writes, tested).

## What was verified and how

- Unit (vitest, 100 tests across 6 suites, red-first): journal record mapping
  and caps, journal reader resync, bridge event hook over a probe process,
  extension wiring for all four run shapes, unwritable-journal resilience,
  watch view state and layout, CLI list/watch/help/--json/unknown-handle.
- PTY (tui-pty-testing skill, tmux probe): live updates while a journal
  appends, running-to-done transition, scroll-back keys, G re-pin, q quit with
  clean terminal restore and no orphan process.
- Floor: ./test.sh green except the documented sandbox known-fails
  (daemon-serialized-refine, 4603, 4685 EXDEV suites); biome and tsgo clean.

## Notes

- The worktree build needed fresh pi-ai/pi-agent/pi-tui dists in the MAIN tree:
  its packages/ai dist was stale (built Aug 14) against the Aug 15 source
  (`SimpleStreamOptions.reasoning` changed), and the worktree's symlinked
  node_modules resolves workspace packages to the main tree via realpath.
  Rebuilding the three dists in the main tree fixed the build; no source files
  in the main tree were touched.
- `getAgentDir()` (not `AXIOM_HOME`) decides the journals directory; the watch
  command also accepts a full journal path.
