// Reconcile the native skill store with the profile's SKILL.md files.
//
// The store is the canonical record; the profile's SKILL.md files are the
// operational view. Reports drift by default; with --write, converges the two.
// Store history is never destroyed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { profileSkillsDir } from "../skill_io.ts";
import { SkillStore } from "../skills.ts";
import { syncSkills, type SkillSyncReport } from "../sync_skills.ts";
import { skillsStorePath } from "./paths.ts";

interface UsageMeta {
  created_by?: string;
  state?: string;
}

function usage(skillsDir: string): Record<string, UsageMeta> {
  const usagePath = join(skillsDir, ".usage.json");
  if (!existsSync(usagePath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(usagePath, "utf8")) as Record<string, UsageMeta>;
  } catch {
    return {};
  }
}

function agentCreated(skillsDir: string): Set<string> {
  const u = usage(skillsDir);
  return new Set(
    Object.entries(u)
      .filter(([, meta]) => meta.created_by === "agent")
      .map(([name]) => name),
  );
}

function curatorStates(skillsDir: string): Record<string, string> {
  const u = usage(skillsDir);
  const out: Record<string, string> = {};
  for (const [name, meta] of Object.entries(u)) {
    out[name] = meta.state ?? "active";
  }
  return out;
}

function printReport(r: SkillSyncReport): void {
  process.stdout.write(
    `imported=${r.imported.length} edited=${r.edited.length} dropped=${r.dropped.length} ` +
      `exported=${r.exported.length} unresolved=${r.unresolved.length} state_changes=${r.state_changes.length}\n`,
  );
  for (const e of r.imported) {
    process.stdout.write(`  +import  ${e}\n`);
  }
  for (const e of r.edited) {
    process.stdout.write(`  ~edit    ${e}\n`);
  }
  for (const e of r.dropped) {
    process.stdout.write(`  -drop    ${e}\n`);
  }
  for (const e of r.exported) {
    process.stdout.write(`  ->export ${e}\n`);
  }
  for (const e of r.unresolved) {
    process.stdout.write(`  ?unres   ${e}\n`);
  }
  for (const e of r.state_changes) {
    process.stdout.write(`  ^state   ${e}\n`);
  }
}

function main(): number {
  const { values } = parseArgs({
    options: {
      write: { type: "boolean" },
    },
  });
  const write = values.write === true;

  const skillsDir = profileSkillsDir();
  const store = new SkillStore(skillsStorePath());

  const report = store.mutate(() =>
    syncSkills(store, skillsDir, agentCreated(skillsDir), write, curatorStates(skillsDir)),
  );

  printReport(report);
  if (write) {
    process.stdout.write("Wrote reconciled skills.json / SKILL.md\n");
  }
  return 0;
}

process.exitCode = main();
