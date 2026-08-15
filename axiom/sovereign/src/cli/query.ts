// Serve read-only queries against the native memory store as JSON on stdout.
//
// The CLI half of the threev0_store tool (registered by the native-store-bridge
// profile plugin). The plugin shells out here rather than importing src/* into
// the Hermes runtime, keeping the runtime env clean.
//
// Memory-axis actions only for now (port #1); summary/skills/skill_history
// arrive with the skills store (port #2).

import { parseArgs } from "node:util";
import { MemoryStore, type Kind } from "../memory.ts";
import { factHistory, facts } from "../query.ts";
import { storePath } from "./paths.ts";

const KIND_VALUES: readonly string[] = ["memory", "user", "identity", "directive"];

function main(): number {
  const { values } = parseArgs({
    options: {
      action: { type: "string" },
      kind: { type: "string" },
      "fact-id": { type: "string" },
    },
  });

  const action = values.action;
  const kind = values.kind;
  if (kind !== undefined && !KIND_VALUES.includes(kind)) {
    process.stderr.write(
      JSON.stringify({ error: `--kind must be one of ${JSON.stringify(KIND_VALUES)}, got ${JSON.stringify(kind)}` }) +
        "\n",
    );
    return 2;
  }

  const mem = new MemoryStore(storePath());

  let result: unknown;
  if (action === "facts") {
    result = { facts: facts(mem, kind as Kind | undefined) };
  } else if (action === "fact_history") {
    const factId = values["fact-id"];
    if (!factId) {
      process.stderr.write(JSON.stringify({ error: "fact_history requires --fact-id" }) + "\n");
      return 2;
    }
    result = { fact_id: factId, history: factHistory(mem, factId) };
  } else {
    process.stderr.write(
      JSON.stringify({ error: `unknown action ${JSON.stringify(action)}` }) + "\n",
    );
    return 2;
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

process.exitCode = main();
