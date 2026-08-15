// Tests for the store-first bridge (memory-tool op -> store mapping) plus the
// retract and mutate paths that live in the same Python test file.
// TypeScript port of 3v0/tests/test_bridge.py.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyOps } from "../src/bridge.ts";
import { MemoryStore, RETRACTED } from "../src/memory.ts";

function makeStore(): { path: string; store: MemoryStore } {
  const dir = mkdtempSync(join(tmpdir(), "axiom-bridge-"));
  const path = join(dir, "mem.json");
  return { path, store: new MemoryStore(path) };
}

// -- retract -------------------------------------------------------------

test("retract marks inactive and recovers", () => {
  const { store } = makeStore();
  const f = store.add("old fact", "memory", "test");
  const r = store.retract(f.id, "background_review");
  assert.notEqual(r, null);
  assert.equal(f.active, false);
  assert.equal(f.superseded_by, RETRACTED);
  assert.ok(!store.active("memory").some((x) => x.content === "old fact"));
  const recovered = store.get(f.id);
  assert.notEqual(recovered, null);
  assert.equal(recovered!.content, "old fact");
  assert.deepEqual(store.history(f.id).map((x) => x.content), ["old fact"]);
  assert.ok(f.note.includes("retracted by background_review"));
});

test("retract missing or inactive returns null", () => {
  const { store } = makeStore();
  assert.equal(store.retract("nope"), null);
  const f = store.add("x", "memory", "test");
  store.retract(f.id);
  assert.equal(store.retract(f.id), null);
});

test("retract persists", () => {
  const { path, store } = makeStore();
  const f = store.add("gone", "memory", "test");
  store.retract(f.id, "test");
  const s2 = new MemoryStore(path);
  assert.ok(!s2.active("memory").some((x) => x.content === "gone"));
});

// -- bridge --------------------------------------------------------------

test("add", () => {
  const { store } = makeStore();
  const n = applyOps(store, "memory", [{ action: "add", content: "new fact" }], "background_review");
  assert.equal(n, 1);
  const f = store.active("memory")[0]!;
  assert.equal(f.content, "new fact");
  assert.equal(f.source, "background_review");
});

test("add idempotent", () => {
  const { store } = makeStore();
  applyOps(store, "memory", [{ action: "add", content: "dup" }], "a");
  const n = applyOps(store, "memory", [{ action: "add", content: "dup" }], "b");
  assert.equal(n, 0);
  assert.equal(store.active("memory").length, 1);
});

test("replace supersedes exactly one", () => {
  const { store } = makeStore();
  const old = store.add("gh = mustbearnold", "memory", "test");
  const n = applyOps(
    store,
    "memory",
    [{ action: "replace", old_text: "mustbearnold", content: "gh = 1deat0r" }],
    "background_review",
  );
  assert.equal(n, 1);
  assert.equal(old.active, false);
  assert.equal(old.superseded_by, store.active("memory")[0]!.id);
  assert.deepEqual(
    store.history(store.active("memory")[0]!.id).map((x) => x.content),
    ["gh = mustbearnold", "gh = 1deat0r"],
  );
});

test("replace without match plain adds", () => {
  const { store } = makeStore();
  store.add("existing", "memory", "test");
  const n = applyOps(
    store,
    "memory",
    [{ action: "replace", old_text: "nonexistent", content: "brand new" }],
    "background_review",
  );
  assert.equal(n, 1);
  const active = new Set(store.active("memory").map((x) => x.content));
  assert.ok(active.has("existing"));
  assert.ok(active.has("brand new"));
});

test("replace ambiguous skips without guessing", () => {
  const { store } = makeStore();
  store.add("apples are red", "memory", "test");
  store.add("applesauce is wet", "memory", "test");
  const n = applyOps(
    store,
    "memory",
    [{ action: "replace", old_text: "apple", content: "replacement" }],
    "background_review",
  );
  assert.equal(n, 0);
  assert.equal(store.active("memory").length, 2);
});

test("remove retracts", () => {
  const { store } = makeStore();
  const f = store.add("delete me", "memory", "test");
  const n = applyOps(store, "memory", [{ action: "remove", old_text: "delete me" }], "background_review");
  assert.equal(n, 1);
  assert.equal(f.active, false);
  assert.equal(f.superseded_by, RETRACTED);
});

test("remove ambiguous skips", () => {
  const { store } = makeStore();
  store.add("a one", "memory", "test");
  store.add("a two", "memory", "test");
  const n = applyOps(store, "memory", [{ action: "remove", old_text: "a" }], "background_review");
  assert.equal(n, 0);
  assert.equal(store.active("memory").length, 2);
});

test("batch mixed", () => {
  const { store } = makeStore();
  const old = store.add("old", "memory", "test");
  const n = applyOps(
    store,
    "memory",
    [
      { action: "add", content: "added" },
      { action: "replace", old_text: "old", content: "replaced" },
      { action: "remove", old_text: "added" },
    ],
    "background_review",
  );
  assert.equal(n, 3);
  assert.deepEqual(new Set(store.active("memory").map((x) => x.content)), new Set(["replaced"]));
  assert.equal(old.active, false);
});

test("bad target refused", () => {
  const { store } = makeStore();
  assert.throws(() => applyOps(store, "identity", [{ action: "add", content: "x" }], "a"));
});

test("unknown action ignored", () => {
  const { store } = makeStore();
  const n = applyOps(store, "memory", [{ action: "frobnicate", content: "x" }], "a");
  assert.equal(n, 0);
});

test("separator content skipped not raised", () => {
  const { store } = makeStore();
  const n = applyOps(store, "memory", [{ action: "add", content: "bad § fact" }], "a");
  assert.equal(n, 0);
  assert.deepEqual(store.active("memory"), []);
});

// -- mutate --------------------------------------------------------------

test("mutate reloads latest under lock", () => {
  const path = join(mkdtempSync(join(tmpdir(), "axiom-mutate-")), "mem.json");
  const s2 = new MemoryStore(path);
  const s1 = new MemoryStore(path);
  s1.add("from s1", "memory", "test");
  assert.ok(!s2.active("memory").some((f) => f.content === "from s1"));
  s2.mutate(() => {
    assert.ok(s2.active("memory").some((f) => f.content === "from s1"));
  });
});
