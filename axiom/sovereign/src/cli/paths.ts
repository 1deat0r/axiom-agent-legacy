// Path resolution for the CLI entrypoints. The store is canonical and lives in
// the package's data/ dir; the profile is a derived view in the Axiom Hermes
// profile's memories/ dir. Both are env-overridable for tests and cross-check.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at src/cli/paths.ts; the package root is three levels up.
const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function storePath(): string {
  return process.env.AXIOM_STORE ?? join(PKG_ROOT, "data", "memory.json");
}

export function profileMemDir(): string {
  return process.env.AXIOM_PROFILE_MEM ?? join(homedir(), ".hermes", "profiles", "axiom", "memories");
}
