// Wire format for the Hermes profile's MEMORY.md / USER.md.
//
// Entries are separated by '§'. This module is the single owner of that format
// so seed/export/sync never disagree on how the profile is parsed or written.
//
// The '§' separator is Hermes-owned — it is how the host's own memory tool reads
// and writes the profile, so Axiom cannot swap it unilaterally. The store
// (data/memory.json) is JSON and can hold anything; the profile is a *projection*
// of the store, and a fact containing a literal '§' (or leading/trailing
// whitespace) cannot round-trip through it. The guard lives here, at the
// boundary: joinEntries refuses to emit an un-parseable wire, and the record
// path refuses such content before it enters the store.

export const SEPARATOR = "§";

export function containsSeparator(content: string): boolean {
  return content.includes(SEPARATOR);
}

export function splitEntries(md: string): string[] {
  return md
    .split(SEPARATOR)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function joinEntries(entries: string[]): string {
  for (const entry of entries) {
    if (containsSeparator(entry)) {
      throw new Error(
        `entry contains the '${SEPARATOR}' separator and cannot be projected to the profile: ${JSON.stringify(entry.slice(0, 40))}`,
      );
    }
  }
  return entries.join(`\n${SEPARATOR}\n`);
}
