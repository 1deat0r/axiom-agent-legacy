// Reconcile the native store with the Hermes profile (store is canonical).
//
// Reports drift by default; with --write, converges the profile to the store's
// active facts — importing profile-only entries into the store and dropping
// superseded entries from the profile. Store history is never destroyed.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MemoryStore } from "../memory.ts";
import { profileText, syncKind, type SyncReport } from "../sync.ts";
import { profileMemDir, storePath } from "./paths.ts";

function printReport(kind: string, r: SyncReport): void {
  process.stdout.write(
    `[${kind}] imported=${r.imported.length} dropped=${r.dropped.length} exported=${r.exported.length}\n`,
  );
  for (const e of r.imported) {
    process.stdout.write(`  +import  ${JSON.stringify(e.slice(0, 60))}\n`);
  }
  for (const e of r.dropped) {
    process.stdout.write(`  -drop    ${JSON.stringify(e.slice(0, 60))}\n`);
  }
  for (const e of r.exported) {
    process.stdout.write(`  ->export ${JSON.stringify(e.slice(0, 60))}\n`);
  }
}

function main(): number {
  const { values } = parseArgs({
    options: {
      write: { type: "boolean" },
    },
  });
  const write = values.write === true;

  const store = new MemoryStore(storePath());
  const memDir = profileMemDir();
  let memMd: string;
  let userMd: string;
  try {
    memMd = readFileSync(join(memDir, "MEMORY.md"), "utf8");
    userMd = readFileSync(join(memDir, "USER.md"), "utf8");
  } catch (err) {
    process.stderr.write(`sync: ${(err as Error).message}\n`);
    return 1;
  }

  store.mutate(() => {
    const memory = syncKind(store, memMd, "memory", write);
    const user = syncKind(store, userMd, "user", write);
    if (write) {
      writeFileSync(join(memDir, "MEMORY.md"), profileText(store, "memory"), "utf8");
      writeFileSync(join(memDir, "USER.md"), profileText(store, "user"), "utf8");
    }
    printReport("memory", memory);
    printReport("user", user);
  });

  if (write) {
    process.stdout.write("Wrote reconciled MEMORY.md / USER.md\n");
  }
  return 0;
}

process.exitCode = main();
