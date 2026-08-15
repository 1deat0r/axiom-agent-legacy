// Tests for the provenance-tracked correction path.
// TypeScript port of 3v0/tests/test_record.py.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemoryStore } from "../src/memory.ts";
import { RecordError, record } from "../src/record.ts";

function makeStore(): { path: string; store: MemoryStore } {
  const dir = mkdtempSync(join(tmpdir(), "axiom-record-"));
  const path = join(dir, "mem.json");
  return { path, store: new MemoryStore(path) };
}

test("plain record", () => {
  const { store } = makeStore();
  const r = record(store, "new fact", "memory", "test");
  assert.deepEqual(r.supersededIds, []);
  assert.ok(store.active("memory").some((f) => f.content === "new fact"));
});

test("supersede by id recovers chain", () => {
  const { store } = makeStore();
  const old = store.add("gh = mustbearnold", "memory", "test");
  const r = record(store, "gh = 1deat0r", "memory", "test", { supersedeId: old.id });
  assert.deepEqual(r.supersededIds, [old.id]);
  assert.equal(old.active, false);
  assert.deepEqual(
    r.chain.map((f) => f.content),
    ["gh = mustbearnold", "gh = 1deat0r"],
  );
});

test("supersede by substring", () => {
  const { store } = makeStore();
  const old = store.add("runtime is ~11 commits behind", "memory", "test");
  const r = record(store, "runtime is now current", "memory", "test", {
    supersedeContains: "11 commits behind",
  });
  assert.deepEqual(r.supersededIds, [old.id]);
  assert.equal(old.active, false);
});

test("ambiguous substring refused", () => {
  const { store } = makeStore();
  store.add("fact about apples", "memory", "test");
  store.add("fact about applesauce", "memory", "test");
  assert.throws(
    () => record(store, "x", "memory", "test", { supersedeContains: "apple" }),
    RecordError,
  );
});

test("missing id refused", () => {
  const { store } = makeStore();
  assert.throws(
    () => record(store, "x", "memory", "test", { supersedeId: "doesnotexist" }),
    RecordError,
  );
});

test("rejects profile separator in content", () => {
  const { store } = makeStore();
  assert.throws(() => record(store, "bad § fact", "memory", "test"), RecordError);
});

test("dry run does not persist", () => {
  const { path, store } = makeStore();
  record(store, "not persisted", "memory", "test", { persist: false });
  const s2 = new MemoryStore(path);
  assert.ok(!s2.active("memory").some((f) => f.content === "not persisted"));
});
