// Axiom native skill store — provenance-aware, versioned skill lineage.
//
// The same lesson the memory store applied to facts, applied to skills: every
// create/patch/edit/write_file/remove_file/delete is recorded as a version with
// provenance, and replacement links the old version to its successor. Nothing
// is ever destroyed — the lineage (which skill superseded which, which skill
// absorbed which) is the point.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { withLock } from "./lock.ts";
import { newId, nowStamp } from "./memory.ts";

export const VALID_ACTIONS = [
  "create",
  "patch",
  "edit",
  "write_file",
  "remove_file",
  "delete",
] as const;

export const STATE_ACTIVE = "active";
export const STATE_STALE = "stale";
export const STATE_ARCHIVED = "archived";
export const VALID_STATES = [STATE_ACTIVE, STATE_STALE, STATE_ARCHIVED] as const;
export type CuratorState = (typeof VALID_STATES)[number];

// ``superseded_by`` sentinels for terminal (decommissioned) skills.
export const RETRACTED = "retracted"; // deleted with no successor (pure prune)
export const ABSORBED = "absorbed";   // deleted with absorbed_into=<umbrella>

export interface SkillVersionData {
  id: string;
  name: string;
  action: string;
  content: string;
  category: string;
  file_path: string;
  source: string;
  created_at: string;
  supersedes: string[];
  superseded_by: string;
  absorbed_into: string;
  note: string;
}

export class SkillVersion {
  readonly id: string;
  readonly name: string;
  readonly action: string;
  content: string;
  category: string;
  file_path: string;
  readonly source: string;
  readonly created_at: string;
  supersedes: string[];
  superseded_by: string;
  absorbed_into: string;
  note: string;

  constructor(data: SkillVersionData) {
    this.id = data.id;
    this.name = data.name;
    this.action = data.action;
    this.content = data.content;
    this.category = data.category;
    this.file_path = data.file_path;
    this.source = data.source;
    this.created_at = data.created_at;
    this.supersedes = data.supersedes ?? [];
    this.superseded_by = data.superseded_by ?? "";
    this.absorbed_into = data.absorbed_into ?? "";
    this.note = data.note ?? "";
  }

  get active(): boolean {
    return !this.superseded_by;
  }

  get terminal(): boolean {
    return this.superseded_by === RETRACTED || this.superseded_by === ABSORBED;
  }

  toData(): SkillVersionData {
    return {
      id: this.id,
      name: this.name,
      action: this.action,
      content: this.content,
      category: this.category,
      file_path: this.file_path,
      source: this.source,
      created_at: this.created_at,
      supersedes: this.supersedes,
      superseded_by: this.superseded_by,
      absorbed_into: this.absorbed_into,
      note: this.note,
    };
  }
}

export interface StateEvent {
  from: string;
  state: string;
  at: string;
  source: string;
}

interface StateRecord {
  current: string;
  history: StateEvent[];
}

interface SkillStorePayload {
  version: number;
  skills: SkillVersionData[];
  states: Record<string, StateRecord>;
}

export class SkillStore {
  private readonly path: string;
  private list: SkillVersion[] = [];
  private states: Record<string, StateRecord> = {};

  constructor(path: string) {
    this.path = path;
    if (existsSync(this.path)) {
      this.load();
    }
  }

  // -- persistence -------------------------------------------------------
  private load(): void {
    if (!existsSync(this.path)) {
      this.list = [];
      this.states = {};
      return;
    }
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as SkillStorePayload;
    this.list = (raw.skills ?? []).map((s) => new SkillVersion(s));
    this.states = raw.states ?? {};
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload: SkillStorePayload = {
      version: 1,
      skills: this.list.map((s) => s.toData()),
      states: this.states,
    };
    writeFileSync(this.path, JSON.stringify(payload, null, 2), "utf8");
  }

  // -- queries -----------------------------------------------------------
  allVersions(): SkillVersion[] {
    return [...this.list];
  }

  versions(name: string): SkillVersion[] {
    return this.list.filter((s) => s.name === name);
  }

  latestActive(name: string): SkillVersion | null {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i]!;
      if (s.name === name && s.active) {
        return s;
      }
    }
    return null;
  }

  active(): SkillVersion[] {
    const seen = new Set<string>();
    const out: SkillVersion[] = [];
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i]!;
      if (seen.has(s.name)) {
        continue;
      }
      seen.add(s.name);
      if (s.active) {
        out.push(s);
      }
    }
    return out.reverse();
  }

  activeNames(): Set<string> {
    return new Set(this.active().map((s) => s.name));
  }

  absorbedBy(name: string): string[] {
    const out = new Set<string>();
    for (const s of this.list) {
      if (s.superseded_by === ABSORBED && s.absorbed_into === name) {
        out.add(s.name);
      }
    }
    return [...out].sort();
  }

  history(name: string): SkillVersion[] {
    return this.versions(name);
  }

  // -- mutations ---------------------------------------------------------
  add(
    name: string,
    action: string,
    source: string,
    content = "",
    category = "",
    filePath = "",
    note = "",
    supersedes: string[] = [],
    persist = true,
  ): SkillVersion {
    if (!(VALID_ACTIONS as readonly string[]).includes(action)) {
      throw new Error(
        `action must be one of ${JSON.stringify([...VALID_ACTIONS].sort())}, got ${JSON.stringify(action)}`,
      );
    }
    if (action === "delete") {
      throw new Error("delete is terminal; use retract()/absorb() instead");
    }

    const version = new SkillVersion({
      id: newId(),
      name,
      action,
      content,
      category,
      file_path: filePath,
      source,
      created_at: nowStamp(),
      supersedes: [...supersedes],
      superseded_by: "",
      absorbed_into: "",
      note,
    });

    if (version.supersedes.length === 0) {
      const head = this.latestActive(name);
      if (head !== null) {
        version.supersedes = [head.id];
      }
    }

    this.list.push(version);
    for (const targetId of version.supersedes) {
      for (const old of this.list) {
        if (old.id === targetId && old.active) {
          old.superseded_by = version.id;
        }
      }
    }
    if (persist) {
      this.save();
    }
    return version;
  }

  private decommission(
    name: string,
    sentinel: string,
    source = "",
    absorbedInto = "",
    persist = true,
  ): SkillVersion | null {
    const head = this.latestActive(name);
    if (head === null) {
      return null;
    }
    head.superseded_by = sentinel;
    if (absorbedInto) {
      head.absorbed_into = absorbedInto;
    }
    if (source) {
      const verb = absorbedInto ? `absorbed into ${absorbedInto}` : "retracted";
      const tag = `${verb} by ${source}`;
      head.note = head.note ? `${head.note} ${tag}`.trim() : tag;
    }
    if (persist) {
      this.save();
    }
    return head;
  }

  retract(name: string, source = "", persist = true): SkillVersion | null {
    return this.decommission(name, RETRACTED, source, "", persist);
  }

  absorb(name: string, absorbedInto: string, source = "", persist = true): SkillVersion | null {
    return this.decommission(name, ABSORBED, source, absorbedInto, persist);
  }

  // -- operational (curator) state ---------------------------------------
  state(name: string): string {
    const rec = this.states[name];
    return rec !== undefined ? rec.current : STATE_ACTIVE;
  }

  stateHistory(name: string): StateEvent[] {
    const rec = this.states[name];
    return rec !== undefined ? [...rec.history] : [];
  }

  setState(name: string, newState: string, source = "", persist = true): StateEvent | null {
    if (!(VALID_STATES as readonly string[]).includes(newState)) {
      throw new Error(
        `state must be one of ${JSON.stringify([...VALID_STATES].sort())}, got ${JSON.stringify(newState)}`,
      );
    }
    const old = this.state(name);
    if (newState === old) {
      return null;
    }
    const rec = this.states[name];
    const history = rec !== undefined ? [...rec.history] : [];
    const event: StateEvent = { from: old, state: newState, at: nowStamp(), source };
    history.push(event);
    this.states[name] = { current: newState, history };
    if (persist) {
      this.save();
    }
    return event;
  }

  // -- concurrency -------------------------------------------------------
  reload(): void {
    this.load();
  }

  mutate<T>(fn: (store: SkillStore) => T): T {
    return withLock(this.path, () => {
      this.reload();
      return fn(this);
    });
  }
}
