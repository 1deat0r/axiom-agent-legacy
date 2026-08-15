// Seed the native skill store from the profile's agent-created skills.
//
// Reads the profile's skills/.usage.json and, for every skill the agent itself
// created (created_by == "agent"), records its SKILL.md as a create version
// with source="profile-import". Bundled / hub-installed skills are excluded.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { findSkillMd, profileSkillsDir } from "../skill_io.ts";
import { SkillStore } from "../skills.ts";
import { skillsStorePath } from "./paths.ts";

interface UsageMeta {
  created_by?: string;
  created_at?: string;
}

function main(): number {
  const { values } = parseArgs({
    options: {
      force: { type: "boolean" },
    },
  });
  const force = values.force === true;

  const skillsDir = profileSkillsDir();
  const storePath = skillsStorePath();
  const store = new SkillStore(storePath);

  if (store.allVersions().length > 0 && !force) {
    process.stderr.write(
      `Skill store already has ${store.allVersions().length} versions; pass --force to re-seed.\n`,
    );
    return 1;
  }
  if (force) {
    // Clear the store (Python: store.skills = []) before re-seeding.
    rmSync(storePath, { force: true });
    store.reload();
  }

  const usagePath = join(skillsDir, ".usage.json");
  if (!existsSync(usagePath)) {
    process.stderr.write(`No ${usagePath} — nothing to seed.\n`);
    return 1;
  }
  const usage = JSON.parse(readFileSync(usagePath, "utf8")) as Record<string, UsageMeta>;

  let n = 0;
  for (const [name, meta] of Object.entries(usage)) {
    if (meta.created_by !== "agent") {
      continue;
    }
    const sf = findSkillMd(skillsDir, name);
    if (sf === null || !sf.content) {
      continue; // archived / moved off the live path — skip
    }
    const createdAt = meta.created_at ?? "";
    const note = `seeded from profile${createdAt ? ` (created ${createdAt})` : ""}`;
    store.add(name, "create", "profile-import", sf.content, sf.category, "", note);
    n += 1;
  }

  process.stdout.write(`Seeded ${n} agent-created skills -> ${storePath}\n`);
  return 0;
}

process.exitCode = main();
