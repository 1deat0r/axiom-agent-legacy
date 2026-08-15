// Read-only views over the native memory store. JSON-serializable objects the
// native-store-bridge plugin serves as a first-class tool (threev0_store).
//
// Read-only by construction: only query methods are called, nothing mutates.
// The skill-axis views (skills / skill_history / summary) arrive with port #2
// (the skills store); this file currently owns the memory axis only.

import type { Fact, Kind, MemoryStore } from "./memory.ts";

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
