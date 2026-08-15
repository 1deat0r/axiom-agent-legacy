// Axiom native memory core — provenance-aware, versioned identity/memory store.
//
// This is the TypeScript port of 3V0's `3v0/core/memory.py`, the first native
// subsystem of the sovereign layer. It applies one lesson from the "context
// engineering" cluster: facts carry provenance, and conflicts are FLAGGED and
// linked, never silently overwritten.
//
// Design:
// - Every fact has an id, kind, source, and creation timestamp.
// - A new fact that contradicts an old one SUPERSEDES it: the old fact is marked
//   inactive (still queryable via history()) and linked to its successor.
//   Nothing is ever destroyed — the audit trail is the point.
// - Plain JSON on disk (stdlib only) so the source of truth is auditable, not
//   hidden in a host profile.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { withLock } from "./lock.ts";

export const VALID_KINDS = ["memory", "user", "identity", "directive"] as const;
export type Kind = (typeof VALID_KINDS)[number];

// ``superseded_by`` sentinel for a fact that was REMOVED (no successor exists).
// Distinct from a real fact id, so ``history()`` terminates the chain at the
// retracted fact, and ``active()``/``export()`` exclude it.
export const RETRACTED = "retracted";

export interface FactData {
  id: string;
  content: string;
  kind: string;
  source: string;
  created_at: string;
  supersedes?: string[];
  superseded_by?: string;
  note?: string;
}

// 12 hex chars, matching Python's ``uuid.uuid4().hex[:12]``.
export function newId(): string {
  return randomBytes(6).toString("hex");
}

// ``YYYY-MM-DDTHH:MM:SSZ`` in UTC, matching
// ``time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())``.
export function nowStamp(): string {
  return new Date().toISOString().slice(0, 19) + "Z";
}

export class Fact {
  readonly id: string;
  content: string;
  readonly kind: string;
  readonly source: string;
  readonly created_at: string;
  supersedes: string[];
  superseded_by: string;
  note: string;

  constructor(data: FactData) {
    this.id = data.id;
    this.content = data.content;
    this.kind = data.kind;
    this.source = data.source;
    this.created_at = data.created_at;
    this.supersedes = data.supersedes ?? [];
    this.superseded_by = data.superseded_by ?? "";
    this.note = data.note ?? "";
  }

  get active(): boolean {
    return !this.superseded_by;
  }

  toData(): FactData {
    return {
      id: this.id,
      content: this.content,
      kind: this.kind,
      source: this.source,
      created_at: this.created_at,
      supersedes: this.supersedes,
      superseded_by: this.superseded_by,
      note: this.note,
    };
  }
}

interface StorePayload {
  version: number;
  facts: FactData[];
}

export class MemoryStore {
  private readonly path: string;
  private facts: Fact[] = [];

  constructor(path: string) {
    this.path = path;
    if (existsSync(this.path)) {
      this.load();
    }
  }

  // -- persistence -------------------------------------------------------
  private load(): void {
    if (!existsSync(this.path)) {
      this.facts = [];
      return;
    }
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as StorePayload;
    this.facts = (raw.facts ?? []).map((f) => new Fact(f));
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload: StorePayload = {
      version: 1,
      facts: this.facts.map((f) => f.toData()),
    };
    writeFileSync(this.path, JSON.stringify(payload, null, 2), "utf8");
  }

  // -- mutations ---------------------------------------------------------
  add(
    content: string,
    kind: Kind,
    source: string,
    supersedes: string[] = [],
    note = "",
    persist = true,
  ): Fact {
    if (!VALID_KINDS.includes(kind)) {
      const sorted = [...VALID_KINDS].sort();
      throw new Error(
        `kind must be one of ${JSON.stringify(sorted)}, got ${JSON.stringify(kind)}`,
      );
    }
    const fact = new Fact({
      id: newId(),
      content,
      kind,
      source,
      created_at: nowStamp(),
      supersedes,
      superseded_by: "",
      note,
    });
    this.facts.push(fact);
    // Link superseded facts to their successor (conflict flagged, not erased).
    for (const targetId of fact.supersedes) {
      for (const old of this.facts) {
        if (old.id === targetId && old.active) {
          old.superseded_by = fact.id;
        }
      }
    }
    if (persist) {
      this.save();
    }
    return fact;
  }

  retract(factId: string, source = "", persist = true): Fact | null {
    const f = this.get(factId);
    if (f === null || !f.active) {
      return null;
    }
    f.superseded_by = RETRACTED;
    if (source) {
      const tag = `retracted by ${source}`;
      f.note = f.note ? `${f.note} ${tag}`.trim() : tag;
    }
    if (persist) {
      this.save();
    }
    return f;
  }

  reload(): void {
    this.load();
  }

  mutate<T>(fn: (store: MemoryStore) => T): T {
    return withLock(this.path, () => {
      this.reload();
      return fn(this);
    });
  }

  // -- queries -----------------------------------------------------------
  active(kind?: Kind): Fact[] {
    let out = this.facts.filter((f) => f.active);
    if (kind !== undefined) {
      out = out.filter((f) => f.kind === kind);
    }
    return out;
  }

  get(factId: string): Fact | null {
    return this.facts.find((f) => f.id === factId) ?? null;
  }

  history(factId: string): Fact[] {
    const byId = new Map<string, Fact>(this.facts.map((f): [string, Fact] => [f.id, f]));
    let cur = byId.get(factId);
    if (cur === undefined) {
      return [];
    }
    while (cur.superseded_by !== "" && byId.has(cur.superseded_by)) {
      cur = byId.get(cur.superseded_by)!;
    }
    const chain: Fact[] = [];
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur.id)) {
      chain.push(cur);
      seen.add(cur.id);
      let prev: Fact | undefined;
      for (const fid of cur.supersedes) {
        const p = byId.get(fid);
        if (p !== undefined) {
          prev = p;
          break;
        }
      }
      cur = prev;
    }
    chain.reverse();
    return chain;
  }

  // -- export ------------------------------------------------------------
  export(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const kind of [...VALID_KINDS].sort()) {
      const lines = this.active(kind).map((f) => f.content);
      if (lines.length > 0) {
        out[kind] = lines;
      }
    }
    return out;
  }
}
