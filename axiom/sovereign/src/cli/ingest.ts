// Ingest a Hermes memory-tool write into the native store (store-first).
//
// Reads a JSON payload on stdin describing one memory-tool write and replays
// it against the store under the cross-process lock. Called by the
// native-store-bridge profile plugin's post_tool_call hook as a best-effort
// subprocess: every failure is reported on stderr with a non-zero exit so the
// caller can swallow it, and the wake-time sync remains the backstop reconciler.
//
// Payload shape (a single JSON object):
//   {
//     "target": "memory",                 // or "user"
//     "source": "background_review",      // write origin (provenance)
//     "ops": [
//       {"action": "add", "content": "..."},
//       {"action": "replace", "old_text": "...", "content": "..."},
//       {"action": "remove", "old_text": "..."}
//     ]
//   }

import { readFileSync } from "node:fs";
import { applyOps, type Op } from "../bridge.ts";
import { MemoryStore } from "../memory.ts";
import { storePath } from "./paths.ts";

interface IngestPayload {
  target?: unknown;
  source?: unknown;
  ops?: unknown;
}

function fail(message: string): number {
  process.stderr.write(`ingest: ${message}\n`);
  return 2;
}

function main(): number {
  let raw: string;
  try {
    raw = readFileSync(process.stdin.fd, "utf8");
  } catch {
    return fail("could not read stdin");
  }

  let payload: IngestPayload;
  try {
    payload = JSON.parse(raw) as IngestPayload;
  } catch (err) {
    return fail(`bad JSON payload: ${(err as Error).message}`);
  }

  const target = payload.target;
  if (target !== "memory" && target !== "user") {
    return fail(`bad target ${JSON.stringify(target)}`);
  }
  const source = String(payload.source ?? "assistant_tool");
  const ops = payload.ops;
  if (!Array.isArray(ops)) {
    return fail("'ops' must be a list");
  }

  const store = new MemoryStore(storePath());
  let applied: number;
  try {
    applied = store.mutate(() => applyOps(store, target, ops as Op[], source));
  } catch (err) {
    process.stderr.write(`ingest failed: ${(err as Error).message}\n`);
    return 1;
  }

  process.stdout.write(JSON.stringify({ applied, target, source }) + "\n");
  return 0;
}

process.exitCode = main();
