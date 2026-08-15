// Ingest a Hermes skill_manage write into the native skill store.
//
// Reads a JSON payload on stdin describing one skill_manage write and replays
// it against the skill store under the cross-process lock. Called by the
// native-store-bridge plugin's post_tool_call hook as a best-effort subprocess.
//
// For a patch the tool args carry only the old/new snippets; the resulting
// SKILL.md is resolved from the profile so the recorded version carries full
// content and can be projected back by sync_skills.

import { readFileSync } from "node:fs";
import { applySkillOp, type SkillOp } from "../skill_bridge.ts";
import { findSkillMd, profileSkillsDir } from "../skill_io.ts";
import { SkillStore } from "../skills.ts";
import { skillsStorePath } from "./paths.ts";

interface IngestSkillsPayload {
  source?: unknown;
  args?: unknown;
}

function fail(message: string): number {
  process.stderr.write(`ingest_skills: ${message}\n`);
  return 2;
}

function main(): number {
  let raw: string;
  try {
    raw = readFileSync(process.stdin.fd, "utf8");
  } catch {
    return fail("could not read stdin");
  }

  let payload: IngestSkillsPayload;
  try {
    payload = JSON.parse(raw) as IngestSkillsPayload;
  } catch (err) {
    return fail(`bad JSON payload: ${(err as Error).message}`);
  }

  const source = String(payload.source ?? "assistant_tool");
  let args = payload.args;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return fail("'args' must be an object");
  }

  // A patch's tool args carry only old/new snippets; resolve the resulting
  // SKILL.md from the profile so the recorded version is projectable.
  if ((args as SkillOp).action === "patch") {
    const name = String((args as SkillOp).name ?? "").trim();
    const sf = findSkillMd(profileSkillsDir(), name);
    if (sf !== null) {
      args = { ...(args as SkillOp), content: sf.content };
    }
  }

  const store = new SkillStore(skillsStorePath());
  let applied: number;
  try {
    applied = store.mutate(() => applySkillOp(store, args, source));
  } catch (err) {
    process.stderr.write(`ingest_skills failed: ${(err as Error).message}\n`);
    return 1;
  }

  process.stdout.write(JSON.stringify({ applied, source }) + "\n");
  return 0;
}

process.exitCode = main();
