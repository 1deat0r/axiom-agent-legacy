// Tests for the read-only store query layer (memory + skill axes).
// TypeScript port of 3v0/tests/test_query.py.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemoryStore } from "../src/memory.ts";
import { factHistory, facts, skillHistory, skills, summary } from "../src/query.ts";
import { STATE_STALE, SkillStore } from "../src/skills.ts";

function makeStores(): { mem: MemoryStore; skl: SkillStore } {
  const dir = mkdtempSync(join(tmpdir(), "axiom-query2-"));
  return { mem: new MemoryStore(join(dir, "mem.json")), skl: new SkillStore(join(dir, "skills.json")) };
}

test("facts filtered by kind", () => {
  const { mem } = makeStores();
  mem.add("one", "memory", "test");
  mem.add("two", "memory", "test");
  mem.add("who", "user", "test");
  const fs = facts(mem, "memory");
  assert.deepEqual(new Set(fs.map((f) => f.content)), new Set(["one", "two"]));
});

test("summary counts facts by kind and versions", () => {
  const { mem, skl } = makeStores();
  mem.add("one", "memory", "test");
  mem.add("two", "memory", "test");
  mem.add("who", "user", "test");
  const s = summary(mem, skl);
  assert.deepEqual(s.facts, { memory: 2, user: 1 });
  assert.equal(s.fact_versions, 3);
});

test("fact history recovers supersession", () => {
  const { mem } = makeStores();
  const old = mem.add("gh is mustbearnold", "memory", "test");
  const fresh = mem.add("gh is 1deat0r", "memory", "test", [old.id]);
  const chain = factHistory(mem, fresh.id);
  assert.deepEqual(chain.map((f) => f.content), ["gh is mustbearnold", "gh is 1deat0r"]);
  assert.equal(chain[0]!.active, false);
  assert.equal(chain[1]!.active, true);
});

test("fact history unknown id is empty", () => {
  const { mem } = makeStores();
  assert.deepEqual(factHistory(mem, "nope"), []);
});

test("skills list is metadata only and carries state", () => {
  const { skl } = makeStores();
  skl.add("alpha", "create", "test", "frontmatter...");
  skl.setState("alpha", STATE_STALE, "test");
  const out = skills(skl, undefined);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, "alpha");
  assert.equal(out[0]!.state, STATE_STALE);
  assert.ok(!("content" in out[0]!));
  assert.equal(out[0]!.content_len, "frontmatter...".length);
});

test("skill history includes bounded content", () => {
  const { skl } = makeStores();
  const body = "x".repeat(5000);
  skl.add("big", "create", "test", body);
  const hist = skillHistory(skl, "big");
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.truncated, true);
  assert.equal(hist[0]!.content_len, 5000);
  assert.ok(hist[0]!.content!.length < 5000);
});

test("skill history short content not truncated", () => {
  const { skl } = makeStores();
  skl.add("small", "create", "test", "hello");
  const hist = skillHistory(skl, "small");
  assert.equal(hist[0]!.truncated, false);
  assert.equal(hist[0]!.content, "hello");
});
