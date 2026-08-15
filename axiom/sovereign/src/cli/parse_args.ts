// parseArgs wrapper that protects string-option values starting with "-".
//
// Node's parseArgs rejects a dash-prefixed value passed as a separate token
// ("--content ---name: foo" -> "argument is ambiguous"), but Python's argparse
// accepts a three-dash value (it only rejects single-dash option-lookalikes).
// Since SKILL.md content begins with "---" (YAML frontmatter), the bridge passes
// content exactly that way. Joining the option and its value with "=" removes
// the ambiguity for every string option, in both the separate-token and
// "=" forms.

import { parseArgs, type ParseArgsConfig } from "node:util";

// String-valued options whose value may legitimately begin with "-".
const VALUE_OPTIONS = new Set([
  "--action",
  "--kind",
  "--content",
  "--name",
  "--category",
  "--source",
  "--supersedes",
  "--supersedes-id",
  "--retract",
  "--fact-id",
  "--absorbed-into",
]);

export function parseArgsSafe<T extends ParseArgsConfig>(
  config: T,
  rawArgv: string[] = process.argv.slice(2),
) {
  const argv: string[] = [];
  for (let i = 0; i < rawArgv.length; i++) {
    const tok = rawArgv[i]!;
    if (VALUE_OPTIONS.has(tok) && i + 1 < rawArgv.length) {
      argv.push(`${tok}=${rawArgv[i + 1]}`);
      i++;
    } else {
      argv.push(tok);
    }
  }
  return parseArgs({ ...config, args: argv });
}
