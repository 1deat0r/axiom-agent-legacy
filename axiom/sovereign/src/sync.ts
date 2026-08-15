// Reconcile the native store with the Hermes profile (store is canonical).
//
// The store is the origin; the profile is a derived view. syncKind converges
// the two without ever destroying store history:
//
// - A profile entry with no matching store fact is imported into the store as
//   a new fact (source="profile-import").
// - A profile entry that matches a SUPERSEDED (inactive) store fact is dropped
//   from the profile, because the store has already corrected it.
// - An active store fact missing from the profile is exported to the profile.
//
// After a write-sync, the profile equals the store's active facts exactly, and
// the store's full supersession history is intact.

import type { Kind, MemoryStore } from "./memory.ts";
import { joinEntries, splitEntries } from "./profile_io.ts";

export interface SyncReport {
  kind: string;
  imported: string[]; // profile -> store (new facts)
  dropped: string[];  // profile entries removed (superseded)
  exported: string[]; // store -> profile (new to profile)
}

export function isClean(report: SyncReport): boolean {
  return (
    report.imported.length === 0 &&
    report.dropped.length === 0 &&
    report.exported.length === 0
  );
}

export function syncKind(
  store: MemoryStore,
  profileMd: string,
  kind: Kind,
  write: boolean,
): SyncReport {
  const profileEntries = splitEntries(profileMd);
  const active = new Set(store.active(kind).map((f) => f.content));
  const inactive = new Set(
    store.allFacts().filter((f) => f.kind === kind && !f.active).map((f) => f.content),
  );

  const imported = profileEntries.filter((e) => !active.has(e) && !inactive.has(e));
  const dropped = profileEntries.filter((e) => inactive.has(e));
  const exported = store
    .active(kind)
    .map((f) => f.content)
    .filter((c) => !profileEntries.includes(c));

  if (write) {
    for (const entry of imported) {
      store.add(entry, kind, "profile-import");
    }
  }
  return { kind, imported, dropped, exported };
}

export function profileText(store: MemoryStore, kind: Kind): string {
  return joinEntries(store.active(kind).map((f) => f.content));
}
