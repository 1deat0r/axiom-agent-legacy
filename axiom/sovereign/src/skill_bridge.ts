// Map Hermes skill_manage operations onto the native skill store.
//
// create      -> append a version (full SKILL.md), starting/continuing the
//                lineage. Idempotent: a create whose content already equals the
//                active version is skipped (double-observation guard).
// patch       -> append a version; note records the old->new snippet. If the
//                caller supplies the resulting SKILL.md as content, the version
//                carries full content too and is projectable.
// edit        -> append a version with the full new SKILL.md.
// write_file  -> append a version carrying the supporting file's content + path.
// remove_file -> append a version recording the removed file.
// delete      -> terminal. With absorbed_into -> absorb; without -> retract.

import type { SkillStore } from "./skills.ts";

const VALID_ACTIONS = new Set(["create", "patch", "edit", "write_file", "remove_file", "delete"]);
const TERMINAL = "delete";

export interface SkillOp {
  action?: string;
  name?: string;
  content?: string;
  category?: string;
  file_path?: string;
  file_content?: string;
  old_string?: string;
  new_string?: string;
  absorbed_into?: string;
}

function truncate(text: unknown, limit = 200): string {
  const s = String(text || "").trim();
  if (s.length <= limit) {
    return s;
  }
  return s.slice(0, limit - 3) + "...";
}

// Emulate Python's str repr (single quotes) so patch notes read identically.
function pyRepr(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

export function applySkillOp(store: SkillStore, args: unknown, source: string): number {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return 0;
  }
  const a = args as SkillOp;
  const action = a.action;
  const name = (a.name ?? "").trim();
  if (!name || action === undefined || !VALID_ACTIONS.has(action)) {
    return 0;
  }

  if (action === TERMINAL) {
    const absorbedInto = (a.absorbed_into ?? "").trim();
    if (absorbedInto) {
      return store.absorb(name, absorbedInto, source) ? 1 : 0;
    }
    return store.retract(name, source) ? 1 : 0;
  }

  const category = (a.category ?? "").trim();
  const filePath = (a.file_path ?? "").trim();
  let content = "";
  let note = "";

  if (action === "create" || action === "edit") {
    content = (a.content ?? "").trim();
  } else if (action === "write_file") {
    content = (a.file_content ?? "").trim();
    note = `write_file ${filePath}`.trim();
  } else if (action === "remove_file") {
    note = `remove_file ${filePath}`.trim();
  } else if (action === "patch") {
    const old = truncate(a.old_string);
    const fresh = truncate(a.new_string);
    note = old || fresh ? `patch ${pyRepr(old)} -> ${pyRepr(fresh)}` : "patch";
    content = (a.content ?? "").trim();
  }

  // Double-observation guard: a create whose content is already the active
  // version is a no-op (the fork and foreground can both observe a write).
  if (action === "create") {
    const head = store.latestActive(name);
    if (head !== null && head.action === "create" && head.content === content) {
      return 0;
    }
  }

  store.add(name, action, source, content, category, filePath, note);
  return 1;
}
