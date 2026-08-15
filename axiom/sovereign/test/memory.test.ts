// Tests for Axiom's native memory core.
// TypeScript port of 3v0/tests/test_memory_core.py — stdlib only, no network.
//
// Run: node --test test/memory.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemoryStore } from "../src/memory.ts";
import { joinEntries, splitEntries } from "../src/profile_io.ts";

function makeStore(): { path: string; store: MemoryStore } {
  const dir = mkdtempSync(join(tmpdir(), "axiom-mem-"));
  const path = join(dir, "mem.json");
  return { path, store: new MemoryStore(path) };
}

test("add and active filter", () => {
  const { store } = makeStore();
  store.add("fact one", "memory", "test");
  store.add("fact two", "user", "test");
  assert.deepEqual(
    store.active().map((f) => f.content),
    ["fact one", "fact two"],
  );
  assert.deepEqual(
    store.active("memory").map((f) => f.content),
    ["fact one"],
  );
});

test("supersede flags, never destroys", () => {
  const { store } = makeStore();
  const old = store.add("gh account is mustbearnold", "memory", "test");
  const fresh = store.add("gh account is 1deat0r", "memory", "test", [old.id]);
  assert.equal(old.active, false);
  assert.equal(old.superseded_by, fresh.id);
  assert.deepEqual(
    store.active("memory").map((f) => f.content),
    ["gh account is 1deat0r"],
  );
  // Provenance chain recovers the full thread, oldest -> newest.
  const chain = store.history(fresh.id);
  assert.deepEqual(
    chain.map((f) => f.content),
    ["gh account is mustbearnold", "gh account is 1deat0r"],
  );
});

test("persistence roundtrip", () => {
  const { path } = makeStore();
  const s = new MemoryStore(path);
  s.add("persisted", "memory", "test");
  const s2 = new MemoryStore(path);
  assert.deepEqual(
    s2.active().map((f) => f.content),
    ["persisted"],
  );
});

test("invalid kind rejected", () => {
  const { store } = makeStore();
  assert.throws(() => store.add("x", "bogus" as never, "test"));
});

test("profile derived view roundtrip", () => {
  const { store } = makeStore();
  const contents = [
    "fact one",
    "fact with (parens) and commas, fine",
    "multi\nline\nfact",
  ];
  for (const c of contents) {
    store.add(c, "memory", "test");
  }
  const mem = joinEntries(store.active("memory").map((f) => f.content));
  assert.deepEqual(splitEntries(mem), contents);
});

test("join refuses separator in content", () => {
  assert.throws(() => joinEntries(["fine", "contains § separator"]));
});

test("mutate reloads and applies under lock", () => {
  const { path } = makeStore();
  const s = new MemoryStore(path);
  const fact = s.mutate((store) => store.add("written under lock", "memory", "test"));
  assert.equal(fact.active, true);
  const s2 = new MemoryStore(path);
  assert.deepEqual(
    s2.active().map((f) => f.content),
    ["written under lock"],
  );
});
