// Provenance-tracked correction: record a fact, optionally superseding an
// existing one. A correction SUPERSEDES the old fact — it is marked inactive
// and linked to its successor, never destroyed. The full thread stays
// recoverable via MemoryStore.history().
//
// Supersession target is precise by design:
// - supersedeId: supersede the fact with this exact id.
// - supersedeContains: supersede the active fact whose content contains this
//   substring, requiring EXACTLY one match (ambiguity or absence refuses).

import type { Fact, Kind, MemoryStore } from "./memory.ts";
import { SEPARATOR, containsSeparator } from "./profile_io.ts";

export class RecordError extends Error {}

export interface RecordResult {
  fact: Fact;
  supersededIds: string[];
  chain: Fact[];
}

export interface RecordOptions {
  supersedeId?: string;
  supersedeContains?: string;
  persist?: boolean;
}

export function record(
  store: MemoryStore,
  content: string,
  kind: Kind,
  source: string,
  options: RecordOptions = {},
): RecordResult {
  const { supersedeId, supersedeContains, persist = true } = options;

  if (containsSeparator(content)) {
    throw new RecordError(
      `content contains the '${SEPARATOR}' profile separator and cannot ` +
        "be projected to the profile; rephrase it before recording",
    );
  }
  if (supersedeId !== undefined && supersedeContains !== undefined) {
    throw new RecordError("give at most one of supersedeId / supersedeContains");
  }

  let targets: Fact[] = [];
  if (supersedeId !== undefined) {
    const target = store.get(supersedeId);
    if (target === null) {
      throw new RecordError(`no fact with id ${JSON.stringify(supersedeId)}`);
    }
    if (!target.active) {
      throw new RecordError(`fact ${JSON.stringify(supersedeId)} is already superseded`);
    }
    targets = [target];
  } else if (supersedeContains !== undefined) {
    const matches = store.active(kind).filter((f) => f.content.includes(supersedeContains));
    if (matches.length !== 1) {
      throw new RecordError(
        `need exactly one active ${kind} fact containing ` +
          `${JSON.stringify(supersedeContains)}, found ${matches.length}`,
      );
    }
    targets = matches;
  }

  const fact = store.add(content, kind, source, targets.map((t) => t.id), "", persist);
  return {
    fact,
    supersededIds: targets.map((t) => t.id),
    chain: store.history(fact.id),
  };
}
