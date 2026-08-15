// Shared skill-file I/O for the skill axis: locating, writing, and removing
// SKILL.md files in the Hermes profile's skills directory. The profile
// directory is the operational system (Hermes loads skills from it); the native
// skill store is the canonical record.
//
// Skills are located by directory name, not by a stored category — a skill that
// was moved between categories is still found.

import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

function expandUser(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

// The active profile's skills directory: AXIOM_SKILLS_DIR (tests / explicit
// override) first, then HERMES_HOME/skills (the runtime's profile), then the
// Axiom profile default.
export function profileSkillsDir(): string {
  const env = process.env.AXIOM_SKILLS_DIR;
  if (env) {
    return expandUser(env);
  }
  const hermesHome = process.env.HERMES_HOME;
  if (hermesHome) {
    return join(expandUser(hermesHome), "skills");
  }
  return join(homedir(), ".hermes", "profiles", "axiom", "skills");
}

export interface SkillFile {
  name: string;
  content: string;
  category: string; // "" when the skill lives at the skills root
  path: string;
}

// Recursively collect SKILL.md paths under dir (does not follow symlinks,
// matching Python's Path.rglob).
function collectSkillMd(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...collectSkillMd(p));
    } else if (e.name === "SKILL.md") {
      out.push(p);
    }
  }
  return out;
}

export function skillIndex(skillsDir: string): Map<string, SkillFile> {
  const index = new Map<string, SkillFile>();
  for (const md of collectSkillMd(skillsDir)) {
    const dirRelParts = relative(skillsDir, dirname(md))
      .split(sep)
      .filter((p) => p.length > 0);
    if (dirRelParts.includes(".archive")) {
      continue;
    }
    const name = basename(dirname(md));
    if (index.has(name)) {
      continue;
    }
    const category = dirRelParts.slice(0, -1).join(sep);
    try {
      index.set(name, { name, content: readFileSync(md, "utf8"), category, path: md });
    } catch {
      // unreadable SKILL.md — skip
    }
  }
  return index;
}

export function findSkillMd(skillsDir: string, name: string): SkillFile | null {
  return skillIndex(skillsDir).get(name) ?? null;
}

export function writeSkillMd(skillsDir: string, name: string, content: string, category = ""): string {
  const target = category ? join(skillsDir, category, name) : join(skillsDir, name);
  mkdirSync(target, { recursive: true });
  const p = join(target, "SKILL.md");
  writeFileSync(p, content, "utf8");
  return p;
}

export function removeSkill(skillsDir: string, name: string): boolean {
  const found = findSkillMd(skillsDir, name);
  if (found === null) {
    return false;
  }
  rmSync(dirname(found.path), { recursive: true, force: true });
  return true;
}
