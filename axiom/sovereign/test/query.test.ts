// Tests for the read-only memory query layer (memory axis only; the skill
// axis arrives with port #2).
// TypeScript port of the fact-axis cases in 3v0/tests/test_query.py.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemoryStore } from "../src/memory.ts";
import { factHistory, facts } from "../src/query.ts";

function makeMem(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "axiom-query-"));
  return new MemoryStore(join(dir, "mem.json"));
}

test("facts filtered by kind", () => {
  const mem = makeMem();
  mem.add("one", "memory", "test");
  mem.add("two", "memory", "test");
  mem.add("who", "user", "test");
  const fs = facts(mem, "memory");
  assert.deepEqual(new Set(fs.map((f) => f.content)), new Set(["one", "two"]));
});

test("fact history recovers supersession", () => {
  const mem = makeMem();
  const old = mem.add("gh is mustbearnold", "memory", "test");
  const fresh = mem.add("gh is 1deat0r", "memory", "test", [old.id]);
  const chain = factHistory(mem, fresh.id);
  assert.deepEqual(chain.map((f) => f.content), ["gh is mustbearnold", "gh is 1deat0r"]);
  assert.equal(chain[0]!.active, false);
  assert.equal(chain[1]!.active, true);
});

test("fact history unknown id is empty", () => {
  const mem = makeMem();
  assert.deepEqual(factHistory(mem, "nope"), []);
});
