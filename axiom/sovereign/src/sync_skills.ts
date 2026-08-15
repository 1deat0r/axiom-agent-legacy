// Reconcile the native skill store with the profile's SKILL.md files.
//
// The store is the canonical record; the profile's SKILL.md files are the
// operational view. syncSkills converges the two without destroying history:
//
// - A profile skill the store has never seen that qualifies as Axiom's own
//   (created_by == "agent") is imported as a create version.
// - A tracked skill whose SKILL.md differs from the store's active head is
//   imported as a new edit version (the profile is the live truth).
// - A store-decommissioned skill still present in the profile is dropped.
// - A store-active skill with full content missing from the profile is exported.
//
// The curator's operational state (active/stale/archived) is folded into the
// store as an append-only transition log, orthogonal to content lineage.

import { removeSkill, skillIndex, writeSkillMd } from "./skill_io.ts";
import { STATE_ARCHIVED, type CuratorState, type SkillStore } from "./skills.ts";

export interface SkillSyncReport {
  imported: string[];    // new create versions
  edited: string[];      // new edit versions (bridge-missed)
  dropped: string[];     // profile skills removed (decommissioned)
  exported: string[];    // SKILL.md rewritten from store
  unresolved: string[];  // content-less heads (not projectable)
  state_changes: string[]; // "name: old->new" curator transitions
}

export function isCleanReport(r: SkillSyncReport): boolean {
  return (
    r.imported.length === 0 &&
    r.edited.length === 0 &&
    r.dropped.length === 0 &&
    r.exported.length === 0 &&
    r.unresolved.length === 0 &&
    r.state_changes.length === 0
  );
}

export function syncSkills(
  store: SkillStore,
  skillsDir: string,
  agentCreated: Set<string>,
  write: boolean,
  curatorStates: Record<string, string> = {},
): SkillSyncReport {
  const report: SkillSyncReport = {
    imported: [],
    edited: [],
    dropped: [],
    exported: [],
    unresolved: [],
    state_changes: [],
  };
  const liveSkills = skillIndex(skillsDir);

  const storeNames = new Set(store.allVersions().map((s) => s.name));
  const domain = new Set([...storeNames, ...agentCreated]);

  for (const name of [...domain].sort()) {
    const curatorState = curatorStates[name] ?? "active";

    // 1. Fold the curator's operational state (append-only transitions).
    const oldState = store.state(name);
    if (oldState !== curatorState) {
      if (write) {
        store.setState(name, curatorState as CuratorState, "curator");
      }
      report.state_changes.push(`${name}: ${oldState}->${curatorState}`);
    }

    // 2. Content reconciliation (archive-aware).
    const head = store.latestActive(name);
    const profile = liveSkills.get(name) ?? null;
    const terminals = store.versions(name).filter((s) => s.terminal);

    if (head === null) {
      if (terminals.length > 0) {
        if (profile !== null) {
          if (write) {
            removeSkill(skillsDir, name);
          }
          report.dropped.push(name);
        }
      } else if (profile !== null && agentCreated.has(name)) {
        if (write) {
          store.add(
            name,
            "create",
            "profile-import",
            profile.content,
            profile.category,
            "",
            "reconciled from profile",
          );
        }
        report.imported.push(name);
      }
    } else if (profile === null) {
      if (curatorState === STATE_ARCHIVED) {
        // Archived, not lost: the curator moved it to .archive/. Do not
        // re-materialize.
      } else if (head.content) {
        if (write) {
          writeSkillMd(skillsDir, name, head.content, head.category);
        }
        report.exported.push(name);
      } else {
        report.unresolved.push(name);
      }
    } else if (!head.content) {
      report.unresolved.push(name);
    } else if (head.content.trim() !== profile.content.trim()) {
      if (write) {
        store.add(
          name,
          "edit",
          "profile-import",
          profile.content,
          profile.category,
          "",
          "reconciled from profile (content differed from store head)",
        );
      }
      report.edited.push(name);
    }
  }

  return report;
}
