// Serve read-only queries against the native stores as JSON on stdout.
//
// The CLI half of the threev0_store tool (registered by the native-store-bridge
// plugin). The plugin shells out here rather than importing src/* into the
// Hermes runtime, keeping the runtime env clean.

import { parseArgs } from "node:util";
import { MemoryStore, type Kind } from "../memory.ts";
import { factHistory, facts, skillHistory, skills, summary } from "../query.ts";
import { SkillStore } from "../skills.ts";
import { skillsStorePath, storePath } from "./paths.ts";

const KIND_VALUES: readonly string[] = ["memory", "user", "identity", "directive"];
const ACTIONS: readonly string[] = ["summary", "facts", "fact_history", "skills", "skill_history"];

function main(): number {
  const { values } = parseArgs({
    options: {
      action: { type: "string" },
      kind: { type: "string" },
      "fact-id": { type: "string" },
      name: { type: "string" },
    },
  });

  const action = values.action;
  const kind = values.kind;
  if (action === undefined || !ACTIONS.includes(action)) {
    process.stderr.write(
      JSON.stringify({ error: `unknown action ${JSON.stringify(action)} (expected one of ${JSON.stringify(ACTIONS)})` }) +
        "\n",
    );
    return 2;
  }
  if (kind !== undefined && !KIND_VALUES.includes(kind)) {
    process.stderr.write(
      JSON.stringify({ error: `--kind must be one of ${JSON.stringify(KIND_VALUES)}, got ${JSON.stringify(kind)}` }) +
        "\n",
    );
    return 2;
  }

  const mem = new MemoryStore(storePath());
  const skl = new SkillStore(skillsStorePath());

  let result: unknown;
  if (action === "summary") {
    result = summary(mem, skl);
  } else if (action === "facts") {
    result = { facts: facts(mem, kind as Kind | undefined) };
  } else if (action === "fact_history") {
    const factId = values["fact-id"];
    if (!factId) {
      process.stderr.write(JSON.stringify({ error: "fact_history requires --fact-id" }) + "\n");
      return 2;
    }
    result = { fact_id: factId, history: factHistory(mem, factId) };
  } else if (action === "skills") {
    result = { skills: skills(skl, values.name) };
  } else {
    // skill_history
    const name = values.name;
    if (!name) {
      process.stderr.write(JSON.stringify({ error: "skill_history requires --name" }) + "\n");
      return 2;
    }
    result = { name, history: skillHistory(skl, name) };
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

process.exitCode = main();
