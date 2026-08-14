# ADR-0069 — Core read tool: bounded, line-numbered file reads

## Status

Accepted (2026-08-15)

## Context

The 2026-08-15 meta for coding-agent cores is a minimal set of deterministic
file tools: read, write, edit, bash (Zechner's mid-2026 argument; the Pi
baseline ships exactly these four). This fork removed the legacy pi-mono
read/write/grep/find/ls builtins (regression #4428) and reads files today by
composing cat/head/sed inside bash or python one-liners in the ipython kernel.
That path works but has no bounds and no guarantees: no line numbering, no
range contract, no byte cap, and heredoc/quoting failure modes (a corrupted
`>>>>>>>` heredoc was observed in production).

## Decision

A dedicated `read` tool joins the core toolset, registered in
`core/tools/index.ts` and active in the default session toolset alongside
`ipython` (`defaultActiveToolNames` and the SDK's `initialActiveToolNames`
default both list it). `--tools read` is accepted by the CLI;
`REMOVED_BUILTIN_TOOL_NAMES` now holds only grep/find/ls.

The tool contract:

1. **Bounded reads.** Default cap 50KB / 2000 lines (the shared truncate.ts
   constants); `maxBytes` overrides. A hard ceiling of 2MB rejects larger
   files with guidance to use bash (head/sed). The stat-then-read order means
   the hard cap is checked before any content is loaded.
2. **1-based line ranges.** `startLine`/`endLine`, clamped to the file,
   validated (positive integers, end >= start), numbered output with
   tab-separated line numbers.
3. **Never writes.** No mutation path exists in the tool.
4. **File-type gate.** Directories, FIFOs, sockets, and device nodes error
   before any read (a FIFO with no writer would otherwise hang the turn).
   Binary content (NUL byte) errors and never enters the context.
5. **Display hygiene.** BOM stripped and reported, CR dropped, truncation
   notice carries the totals and the next step.

The five-case threat corpus for read (directory listing, symlink escape,
binary leakage, hard-cap exhaustion, trailing-newline line arithmetic) lives
in `test/read-write-threat-corpus.test.ts`; the write cases arrive with the
stacked `feat/write-tool` branch (issue #46).

## Consequences

- Sessions without an explicit tool allowlist now expose `read` in the
  system prompt alongside `ipython`. Prompt snapshot tests pass unchanged.
- Files >= 2MB cannot be read by the tool even with a range; bash remains the
  escape hatch. This is deliberate: the tool trades capability for determinism.
- Regression #4428's assertions were updated to the new builtin set
  (ipython + read). grep/find/ls stay removed.
- The write tool (issue #46) stacks on this branch and reuses the threat
  corpus file.
