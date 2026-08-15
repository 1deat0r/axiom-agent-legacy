// Apply a store-first skill decision and project the derived SKILL.md.
//
// update (append a content version, superseding the active one), retract
// (prune, recoverable), or absorb (fold into an umbrella) — then project the
// profile's SKILL.md so the profile stays the operational (derived) view.

import { writeFileSync } from "node:fs";
import { decideSkill, type SkillDecision, type SkillDecideResult } from "../decide_skills.ts";
import { findSkillMd, profileSkillsDir, removeSkill, writeSkillMd } from "../skill_io.ts";
import { SkillStore } from "../skills.ts";
import { parseArgsSafe } from "./parse_args.ts";
import { skillsStorePath } from "./paths.ts";

const ACTIONS = ["skill_update", "skill_retract", "skill_absorb"] as const;

function project(name: string, action: string, content: string, category: string): string {
  const skillsDir = profileSkillsDir();
  if (action === "skill_update") {
    const existing = findSkillMd(skillsDir, name);
    if (existing !== null) {
      writeFileSync(existing.path, content, "utf8");
      return existing.path;
    }
    return writeSkillMd(skillsDir, name, content, category || "");
  }
  const removed = removeSkill(skillsDir, name);
  return removed ? "removed" : "absent";
}

function printHuman(result: SkillDecideResult): void {
  const skill = result.skill;
  if (skill === undefined) {
    return;
  }
  process.stdout.write(`${result.action} ok: name=${skill.name} version=${skill.id}\n`);
  const supersededIds = result.superseded_ids;
  if (supersededIds !== undefined && supersededIds.length > 0) {
    process.stdout.write(`supersedes: ${JSON.stringify(supersededIds)}\n`);
  }
  if (result.absorbed_into) {
    process.stdout.write(`absorbed into: ${result.absorbed_into}\n`);
  }
  const chain = result.chain ?? [];
  if (chain.length > 0) {
    process.stdout.write("chain (oldest -> newest):\n");
    for (const v of chain) {
      const mark = v.id === skill.id ? "*" : " ";
      process.stdout.write(` ${mark} [${v.id}] ${v.action} by ${v.source}\n`);
    }
  }
}

function main(): number {
  const { values } = parseArgsSafe({
    options: {
      action: { type: "string" },
      name: { type: "string" },
      content: { type: "string" },
      category: { type: "string", default: "" },
      "absorbed-into": { type: "string", default: "" },
      source: { type: "string", default: "foreground" },
      write: { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  const action = values.action;
  const name = values.name ?? "";
  const content = values.content ?? "";
  const category = values.category ?? "";
  const absorbedInto = values["absorbed-into"] ?? "";

  if (action === undefined || !(ACTIONS as readonly string[]).includes(action)) {
    process.stderr.write("--action is required (skill_update|skill_retract|skill_absorb)\n");
    return 2;
  }
  if (!name) {
    process.stderr.write("--name is required\n");
    return 2;
  }

  const decision: SkillDecision = { action, source: String(values.source ?? "foreground"), name };
  if (action === "skill_update") {
    if (!content.trim()) {
      process.stderr.write("--content is required for skill_update\n");
      return 2;
    }
    decision.content = content;
    decision.category = category;
  } else if (action === "skill_absorb") {
    if (!absorbedInto.trim()) {
      process.stderr.write("--absorbed-into is required for skill_absorb\n");
      return 2;
    }
    decision.absorbed_into = absorbedInto;
  }

  const store = new SkillStore(skillsStorePath());
  const decided = store.mutate(() => decideSkill(store, decision, values.write === true));

  if (decided.error !== undefined) {
    if (values.json) {
      process.stdout.write(JSON.stringify(decided, null, 2) + "\n");
    } else {
      process.stderr.write(`refused: ${decided.error}\n`);
    }
    return 1;
  }

  let projected: string | undefined;
  if (values.write) {
    projected = project(name, action, content, category);
  }

  if (values.json) {
    const output = { ...decided, ...(projected !== undefined ? { projected } : {}) };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else {
    printHuman(decided);
    if (projected !== undefined) {
      process.stdout.write(`Projected to ${projected}\n`);
    } else {
      process.stdout.write("(dry run — pass --write to persist and project)\n");
    }
  }

  return 0;
}

process.exitCode = main();
