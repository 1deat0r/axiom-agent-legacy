---
name: ast-grep
description: >-
  Structural code search with ast-grep (tree-sitter pattern matching).
  Use when a search question is about code SHAPE, not text - find a definition,
  find every call site of a function, find where a class is instantiated,
  match a syntax pattern across a language. Do NOT use for plain text search
  (identifiers, strings, TODOs) - use the grep tool for that.
---

# ast-grep — structural search

ast-grep matches code by syntax, not by text. It uses tree-sitter patterns.
It is the structural companion to the `grep` tool (which is lexical).

## Rule: pick the right tool

| Question | Tool |
| --- | --- |
| Where does the text "TODO" or "parseConfig" appear? | `grep` tool |
| Where is `parseConfig` DEFINED? | ast-grep |
| Who CALLS `parseConfig` (real call sites, no comments)? | ast-grep |
| Where is `new Handler(...)` instantiated? | ast-grep |
| Where does code build SQL by string concatenation? | ast-grep |

## Install check

Run `ast-grep --version` in a bash cell first.

If ast-grep is absent, install it with one of:

```bash
npm i -g @ast-grep/cli
# or
brew install ast-grep
```

If you cannot install it, say so and use the `grep` tool with a regex
approximation instead. Never pretend a text search is a structural search.

## Core recipes

All commands run in a bash cell from the repo root.

### Find a definition

```bash
ast-grep run --pattern 'function $NAME($$$ARGS) { $$$BODY }' --lang ts --json
```

Add `--filter NAME=parseConfig` to keep only one name.

### Find every call site of a function

```bash
ast-grep run --pattern 'parseConfig($$$ARGS)' --lang ts --json
```

### Find instantiations

```bash
ast-grep run --pattern 'new Handler($$$ARGS)' --lang ts --json
```

### Find a pattern in many languages at once

```bash
ast-grep run --pattern '$FUNC($$$ARGS)' --lang js --lang ts --json
```

## Rules

- Use `--json` always. Parse the output in the IPython kernel when you need
  to filter or count.
- One pattern per run. A metavariable is `$NAME` (one node) or `$$$NAME`
  (many nodes). They bind to syntax nodes, never to text.
- Use `--filter` to bind a metavariable to a value.
- Scope the search with `--lang` or a file glob (`--glob`). A repo-wide run
  without a language is slow.
- When the result set is large, pipe through `head` or reduce the pattern.
  The JSON output is verbose.
- Read the matched file with the `read` tool when you need the full context.
