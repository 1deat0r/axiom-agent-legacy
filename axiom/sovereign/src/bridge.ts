// Map Hermes memory-tool operations onto the native store.
//
// add      -> store.add(content, kind, source) if not already active (idempotent).
// replace  -> supersede the EXACTLY ONE active fact containing old_text (via
//             record, linking old -> new). Zero or multiple matches -> plain
//             add of the new content (never a guessed supersession link).
// remove   -> retract the EXACTLY ONE active fact containing old_text. Zero or
//             multiple -> skip.
//
// Skipped/ambiguous operations self-heal at the next wake sync, which
// reconciles store and profile idempotently — the only cost is that provenance
// degrades to "profile-import" instead of the exact origin.

import type { Kind, MemoryStore } from "./memory.ts";
import { containsSeparator } from "./profile_io.ts";
import { RecordError, record } from "./record.ts";

const KINDS = new Set<Kind>(["memory", "user"]);

export interface Op {
  action?: string;
  content?: string;
  old_text?: string;
}

function activeContents(store: MemoryStore, kind: Kind): Set<string> {
  return new Set(store.active(kind).map((f) => f.content));
}

export function applyOps(
  store: MemoryStore,
  target: string,
  ops: Op[],
  source: string,
): number {
  if (!KINDS.has(target as Kind)) {
    throw new Error(
      `target must be one of ${JSON.stringify([...KINDS].sort())}, got ${JSON.stringify(target)}`,
    );
  }
  const kind = target as Kind;
  let applied = 0;

  for (const op of ops ?? []) {
    if (typeof op !== "object" || op === null) {
      continue;
    }
    const action = op.action;
    const content = (op.content ?? "").trim();
    const oldText = (op.old_text ?? "").trim();

    try {
      if (action === "add") {
        if (content && !containsSeparator(content) && !activeContents(store, kind).has(content)) {
          store.add(content, kind, source);
          applied += 1;
        }
      } else if (action === "replace") {
        if (!content) {
          continue;
        }
        if (oldText) {
          const matches = store.active(kind).filter((f) => f.content.includes(oldText));
          if (matches.length === 1) {
            record(store, content, kind, source, { supersedeId: matches[0]!.id });
            applied += 1;
            continue;
          }
          if (matches.length > 1) {
            // Ambiguous: never guess which fact to supersede. Skip; the wake
            // sync reconciles store<->profile idempotently.
            continue;
          }
        }
        // No old_text, or zero matches -> plain add of the new content.
        if (!containsSeparator(content) && !activeContents(store, kind).has(content)) {
          store.add(content, kind, source);
          applied += 1;
        }
      } else if (action === "remove") {
        if (!oldText) {
          continue;
        }
        const matches = store.active(kind).filter((f) => f.content.includes(oldText));
        if (matches.length === 1) {
          store.retract(matches[0]!.id, source);
          applied += 1;
        }
      }
      // unknown action -> ignore (never fail the whole batch)
    } catch (err) {
      if (err instanceof RecordError) {
        // e.g. separator-containing content refused by record(); skip and let
        // the wake sync reconcile.
        continue;
      }
      throw err;
    }
  }

  return applied;
}
