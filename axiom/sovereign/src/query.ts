// Read-only views over the native stores (memory axis + skill axis).
// JSON-serializable objects the native-store-bridge plugin serves as a
// first-class tool (threev0_store). Read-only by construction: only query
// methods are called, nothing mutates.

import type { Fact, Kind, MemoryStore } from "./memory.ts";
import type { SkillStore, SkillVersion } from "./skills.ts";

// Cap on inline content in list/history views. The stores record full SKILL.md
// content per version; longer content is truncated and flagged so the caller
// can read the live copy when it needs the actual text.
const CONTENT_CAP = 2000;

// -- memory axis ---------------------------------------------------------

export interface FactView {
  id: string;
  kind: string;
  content: string;
  source: string;
  created_at: string;
  supersedes: string[];
  superseded_by: string;
  active: boolean;
  note: string;
}

export function factDict(f: Fact): FactView {
  return {
    id: f.id,
    kind: f.kind,
    content: f.content,
    source: f.source,
    created_at: f.created_at,
    supersedes: [...f.supersedes],
    superseded_by: f.superseded_by,
    active: f.active,
    note: f.note,
  };
}

export function facts(mem: MemoryStore, kind?: Kind): FactView[] {
  return mem.active(kind).map(factDict);
}

export function factHistory(mem: MemoryStore, factId: string): FactView[] {
  return mem.history(factId).map(factDict);
}

// -- skill axis ----------------------------------------------------------

export interface SkillVersionView {
  id: string;
  name: string;
  action: string;
  category: string;
  file_path: string;
  source: string;
  created_at: string;
  supersedes: string[];
  superseded_by: string;
  absorbed_into: string;
  active: boolean;
  terminal: boolean;
  note: string;
  content_len: number;
  content?: string;
  truncated?: boolean;
}

function contentView(content: string): { content: string; truncated: boolean } {
  if (content.length <= CONTENT_CAP) {
    return { content, truncated: false };
  }
  return { content: content.slice(0, CONTENT_CAP), truncated: true };
}

export function versionDict(v: SkillVersion, includeContent: boolean): SkillVersionView {
  const d: SkillVersionView = {
    id: v.id,
    name: v.name,
    action: v.action,
    category: v.category,
    file_path: v.file_path,
    source: v.source,
    created_at: v.created_at,
    supersedes: [...v.supersedes],
    superseded_by: v.superseded_by,
    absorbed_into: v.absorbed_into,
    active: v.active,
    terminal: v.terminal,
    note: v.note,
    content_len: v.content.length,
  };
  if (includeContent) {
    const cv = contentView(v.content);
    d.content = cv.content;
    d.truncated = cv.truncated;
  }
  return d;
}

export interface SkillSummaryView extends SkillVersionView {
  state: string;
}

export function skills(skl: SkillStore, name?: string): SkillSummaryView[] {
  let active = skl.active();
  if (name) {
    active = active.filter((s) => s.name === name);
  }
  return active.map((s) => ({ ...versionDict(s, false), state: skl.state(s.name) }));
}

export function skillHistory(skl: SkillStore, name: string): SkillVersionView[] {
  return skl.history(name).map((v) => versionDict(v, true));
}

export interface SummaryResult {
  facts: Record<string, number>;
  fact_versions: number;
  active_skills: number;
  skill_versions: number;
  skill_states: Record<string, string>;
}

export function summary(mem: MemoryStore, skl: SkillStore): SummaryResult {
  const byKind: Record<string, number> = {};
  for (const f of mem.active()) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  }
  const activeSkills = skl.active();
  const skillStates: Record<string, string> = {};
  for (const s of activeSkills) {
    skillStates[s.name] = skl.state(s.name);
  }
  return {
    facts: byKind,
    fact_versions: mem.allFacts().length,
    active_skills: activeSkills.length,
    skill_versions: skl.allVersions().length,
    skill_states: skillStates,
  };
}
