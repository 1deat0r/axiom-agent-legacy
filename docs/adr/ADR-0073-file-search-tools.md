# ADR-0073: File-system search returns as purpose-built tools

Status: accepted
Date: 2026-08-15

## Context

The fork removed the baseline's `grep` tool (commit 4a7a55c9a, "make ipython
default and remove legacy tools") so every search became an ad-hoc bash
command. The 2026 agent-search meta shows that ad-hoc grep costs tokens: a
lexical search is the wrong tool for structural questions, and an unshaped
`rg` invocation returns noise the model reads and filters. The published
evidence is three-part: the "grep replacement is three tools, not one" field
guide (lexical / structural / graph modalities); the arXiv study "Is Grep All
You Need?" (2605.15184, May 2026) showing grep beats vector retrieval across
provider harnesses; and the cross-agent survey of grep implementations (Codex
returns filenames sorted by mtime, OpenCode returns line-numbered matches,
Cursor indexes n-grams for monorepos).

## Decision

Restore file-system search as purpose-built tools with the meta's shape, in
two of the three modalities:

1. **Lexical — the `grep` tool.** A built-in tool wrapping ripgrep with two
   modes. `files` mode (default) returns matching file paths sorted by
   last-modified (`rg --files-with-matches --sortr=modified`), the Codex
   shape: narrow the candidate set, then read the files. `content` mode
   returns matches with `path:line: text` lines and optional context,
   the OpenCode shape. Both modes respect `.gitignore`, cap at a limit
   (default 100, max 2000), truncate long lines (500 chars) and the final
   text (50KB), and fail with clear errors for a missing `rg`, a missing
   path, or a bad regex. Sorting is delegated to ripgrep; when the installed
   `rg` is older than 14.0 (no `--sortr`), the tool retries without it and
   notes the fallback. Operations are injectable, so tests run without `rg`
   and remote adapters can replace local search.
2. **Structural — the `ast-grep` skill.** A markdown skill teaching the agent
   to run ast-grep (tree-sitter pattern matching) for code-shape questions:
   definitions, call sites, instantiations. The skill ships recipes and the
   rule for choosing between the `grep` tool and ast-grep.

The **graph modality is deferred**: a call-graph index (resolved
call/usage/implements edges) is a separate capability, tracked as future
work, not bolted onto the lexical tool.

## Considered options

- **One mega-tool with every command** — rejected: the meta's lesson is that
  one tool answering every search question is the grep failure mode repeated;
  the three modalities have different match semantics and different costs.
- **Vector/embedding search** — rejected: the May 2026 arXiv comparison found
  grep more accurate than vector retrieval in agent loops across harnesses,
  and an index adds standing infrastructure for no measured gain here.
- **Restore `find`/`ls` as well** — rejected: the meta agents do not ship
  them as model-facing tools; bash covers file listing, and every tool added
  spends prompt budget.

## Consequences

- `grep` joins `ipython`, `read`, `write` as a built-in tool and is active by
  default (CLI `--tools` accepts it; `find`/`ls` stay removed).
- The model has one shaped interface for lexical search; the prompt
  contribution points at the ast-grep skill for structural questions.
- A call-graph index is a future ADR; until then structural search is
  pattern-based via ast-grep.
