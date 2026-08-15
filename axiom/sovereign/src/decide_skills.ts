// The skill half of the store-first actuator surface. A decision is a
// store-first mutation applied to the SkillStore — append a content version
// (skill_update), decommission with no successor (skill_retract), or fold into
// an umbrella (skill_absorb) — returning a JSON-safe result.
//
// Never raises: invalid input returns {error: ...}. persist=false is dry-run.

import type { SkillStore } from "./skills.ts";
import { versionDict, type SkillVersionView } from "./query.ts";

const VALID_ACTIONS = ["skill_update", "skill_retract", "skill_absorb"] as const;

export interface SkillDecision {
  action?: string;
  name?: string;
  content?: string;
  category?: string;
  note?: string;
  absorbed_into?: string;
  source?: string;
}

export interface SkillDecideResult {
  error?: string;
  ok?: boolean;
  action?: string;
  skill?: SkillVersionView;
  superseded_ids?: string[];
  absorbed_into?: string;
  chain?: SkillVersionView[];
}

function update(store: SkillStore, d: SkillDecision, source: string, persist: boolean): SkillDecideResult {
  const name = (d.name ?? "").trim();
  const content = (d.content ?? "").trim();
  if (!name) {
    return { error: "name is required for action='skill_update'" };
  }
  if (!content) {
    return { error: "content (full SKILL.md) is required for action='skill_update'" };
  }
  const category = (d.category ?? "").trim();
  const note = (d.note ?? "").trim();
  const version = store.add(name, "edit", source, content, category, "", note, [], persist);
  return {
    ok: true,
    action: "skill_update",
    skill: versionDict(version, true),
    superseded_ids: [...version.supersedes],
    chain: store.history(name).map((v) => versionDict(v, true)),
  };
}

function retract(store: SkillStore, d: SkillDecision, source: string, persist: boolean): SkillDecideResult {
  const name = (d.name ?? "").trim();
  if (!name) {
    return { error: "name is required for action='skill_retract'" };
  }
  if (store.latestActive(name) === null) {
    return { error: `no active skill named ${JSON.stringify(name)} to retract` };
  }
  const retracted = store.retract(name, source, persist);
  if (retracted === null) {
    return { error: `could not retract ${JSON.stringify(name)}` };
  }
  return {
    ok: true,
    action: "skill_retract",
    skill: versionDict(retracted, true),
    chain: store.history(name).map((v) => versionDict(v, true)),
  };
}

function absorb(store: SkillStore, d: SkillDecision, source: string, persist: boolean): SkillDecideResult {
  const name = (d.name ?? "").trim();
  const absorbedInto = (d.absorbed_into ?? "").trim();
  if (!name) {
    return { error: "name is required for action='skill_absorb'" };
  }
  if (!absorbedInto) {
    return { error: "absorbed_into is required for action='skill_absorb'" };
  }
  if (store.latestActive(name) === null) {
    return { error: `no active skill named ${JSON.stringify(name)} to absorb` };
  }
  const absorbed = store.absorb(name, absorbedInto, source, persist);
  if (absorbed === null) {
    return { error: `could not absorb ${JSON.stringify(name)}` };
  }
  return {
    ok: true,
    action: "skill_absorb",
    skill: versionDict(absorbed, true),
    absorbed_into: absorbedInto,
    chain: store.history(name).map((v) => versionDict(v, true)),
  };
}

export function decideSkill(store: SkillStore, decision: SkillDecision, persist = true): SkillDecideResult {
  const action = (decision.action ?? "").trim();
  const source = (decision.source ?? "").trim() || "foreground";

  if (action === "skill_update") {
    return update(store, decision, source, persist);
  }
  if (action === "skill_retract") {
    return retract(store, decision, source, persist);
  }
  if (action === "skill_absorb") {
    return absorb(store, decision, source, persist);
  }
  return {
    error: `unknown action ${JSON.stringify(action)} (expected one of ${JSON.stringify(VALID_ACTIONS)})`,
  };
}
