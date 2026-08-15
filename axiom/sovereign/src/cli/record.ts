// Record or retract a fact in the native store and export the derived view.
//
// The store-first decision path: supersede an old fact (recoverable via
// history) instead of silently rewriting the profile, or retract a fact (mark
// it removed), then re-export so the Hermes profile stays a derived view.
//
// Default: dry run (prints what would change, writes nothing). Pass --write to
// persist and export. --json emits a machine-readable result on stdout.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decide, type DecideResult, type Decision } from "../decide.ts";
import { MemoryStore } from "../memory.ts";
import { profileText } from "../sync.ts";
import { parseArgsSafe } from "./parse_args.ts";
import { profileMemDir, storePath } from "./paths.ts";

function printHuman(result: DecideResult): void {
  const fact = result.fact;
  if (fact === undefined) {
    return;
  }
  process.stdout.write(`${result.action} ok: fact id=${fact.id} kind=${fact.kind}\n`);
  const supersededIds = result.superseded_ids;
  if (supersededIds !== undefined && supersededIds.length > 0) {
    process.stdout.write(`supersedes: ${JSON.stringify(supersededIds)}\n`);
  }
  const chain = result.chain;
  if (chain !== undefined && chain.length > 0) {
    process.stdout.write("chain (oldest -> newest):\n");
    for (const f of chain) {
      const mark = f.id === fact.id ? "*" : " ";
      process.stdout.write(` ${mark} [${f.id}] ${f.content.slice(0, 70)}\n`);
    }
  }
}

function main(): number {
  const { values } = parseArgsSafe({
    options: {
      kind: { type: "string" },
      content: { type: "string" },
      source: { type: "string", default: "foreground" },
      "supersedes-id": { type: "string" },
      supersedes: { type: "string" },
      retract: { type: "string" },
      write: { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  const retract = values.retract;
  const content = values.content;
  const supersedesId = values["supersedes-id"];
  const supersedes = values.supersedes;

  if (retract !== undefined && (content || supersedesId || supersedes)) {
    process.stderr.write("--retract cannot be combined with --content/--supersedes*\n");
    return 2;
  }
  if (retract === undefined && !content) {
    process.stderr.write("either --content (record) or --retract <id> is required\n");
    return 2;
  }

  const decision: Decision = {
    action: retract !== undefined ? "retract" : "record",
    source: String(values.source ?? "foreground"),
  };
  if (retract !== undefined) {
    decision.fact_id = retract;
  } else {
    decision.kind = values.kind;
    decision.content = content;
    if (supersedesId) {
      decision.fact_id = supersedesId;
    }
    if (supersedes) {
      decision.supersedes = supersedes;
    }
  }

  const store = new MemoryStore(storePath());
  const decided = store.mutate(() => decide(store, decision, values.write === true));

  if (decided.error !== undefined) {
    if (values.json) {
      process.stdout.write(JSON.stringify(decided, null, 2) + "\n");
    } else {
      process.stderr.write(`refused: ${decided.error}\n`);
    }
    return 1;
  }

  if (values.write) {
    const memDir = profileMemDir();
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "MEMORY.md"), profileText(store, "memory"), "utf8");
    writeFileSync(join(memDir, "USER.md"), profileText(store, "user"), "utf8");
  }

  if (values.json) {
    const output = { ...decided, ...(values.write ? { projected: ["MEMORY.md", "USER.md"] } : {}) };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else {
    printHuman(decided);
    if (values.write) {
      process.stdout.write("Exported derived view to profile MEMORY.md / USER.md\n");
    } else {
      process.stdout.write("(dry run — pass --write to persist and export)\n");
    }
  }

  return 0;
}

process.exitCode = main();
