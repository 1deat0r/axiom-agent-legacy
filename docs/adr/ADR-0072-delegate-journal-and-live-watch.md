# ADR-0072: Delegate journal and live watch

Status: accepted
Date: 2026-08-15

## Context

The delegate tool runs helpers in separate processes. The parent session sees
only the compact result block. The helper's activity stays inside the helper.
A human at the terminal cannot see what a helper does. Background runs are
worse: they detach fully, and only a result file appears when they settle.

## Decision

Every delegate run writes an activity journal. The journal is an append-only
JSONL file at `<agent-dir>/delegate-results/<handle>.journal.jsonl`. The
journal has bounded records: start, assistant text, tool call, tool result,
turn, and end. Text caps bound the file: 2000 chars per assistant record, 300
per tool argument record. The journal is best-effort. A failed write never
fails the delegation.

The bridge forwards helper agent events through a new `onEvent` hook on
`RpcDelegateBridge`. The delegate extension projects events into journal
records and writes them. Foreground runs get a run id and expose
`journalFile` in the tool details. Background runs journal under their
handle and expose `journalFile` in the start block.

Two CLI commands read the journals:

- `axiom delegate list [--json]` lists recent runs: handle, age, status, task,
  model. Newest first.
- `axiom delegate watch <handle|path>` opens a live TUI. It polls the journal
  every 250 ms. Keys: q or Ctrl-C quits, up/down or j/k scrolls, g and G jump
  to the top and the newest line. The view pins to the newest line until the
  user scrolls. It shows the final block when the run settles. When stdout is
  not a terminal, it prints a one-shot tail. `--json` dumps the records.

The watch view logic is pure (`watch-view.ts`): records in, screen lines out.
The TUI driver (`watch-tui.ts`) owns raw mode, the poll timer, key handling,
and painting. It uses `ProcessTerminal` from pi-tui.

## Considered options

- **Reuse the RPC observed-session event stream** — rejected. Helpers run in
  their own session. Observation needs a session id and an observe call. The
  bridge already receives typed agent events.
- **Tee the helper's stdout** — rejected. Raw JSON-RPC lines are noisy. The
  typed event stream is already there.
- **Journal from the bridge event hook** — chosen. One narrow seam, no new
  process contract, and the journal is readable by any tool.

## Consequences

- A human can watch any delegate run live from the terminal.
- Journals grow with run activity. The caps bound each record. Old journals
  are not rotated. The list command makes cleanup easy to see.
- The watch view shows the helper's streamed text, not its full context.
- The TUI polls. It does not watch the file with fs events. 250 ms is enough
  for human reading and keeps the driver simple.
