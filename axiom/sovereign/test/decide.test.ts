// Tests for the store-first decision actuator.
// TypeScript port of 3v0/tests/test_decide.py.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { decide } from "../src/decide.ts";
import { MemoryStore, RETRACTED } from "../src/memory.ts";

function makeStore(): { path: string; store: MemoryStore } {
  const dir = mkdtempSync(join(tmpdir(), "axiom-decide-"));
  const path = join(dir, "mem.json");
  return { path, store: new MemoryStore(path) };
}

test("record plain", () => {
  const { store } = makeStore();
  const r = decide(store, { action: "record", kind: "memory", content: "new fact" });
  assert.equal(r.ok, true);
  assert.equal(r.action, "record");
  assert.equal(r.fact!.content, "new fact");
  assert.deepEqual(r.superseded_ids, []);
  assert.ok(store.active("memory").some((f) => f.content === "new fact"));
});

test("record supersede by id recovers chain", () => {
  const { store } = makeStore();
  const old = store.add("gh = mustbearnold", "memory", "test");
  const r = decide(store, {
    action: "record",
    kind: "memory",
    content: "gh = 1deat0r",
    fact_id: old.id,
  });
  assert.deepEqual(r.superseded_ids, [old.id]);
  assert.equal(old.active, false);
  assert.deepEqual(r.chain!.map((f) => f.content), ["gh = mustbearnold", "gh = 1deat0r"]);
});

test("record supersede by substring", () => {
  const { store } = makeStore();
  const old = store.add("runtime is ~11 commits behind", "memory", "test");
  const r = decide(store, {
    action: "record",
    kind: "memory",
    content: "runtime is current",
    supersedes: "11 commits behind",
  });
  assert.deepEqual(r.superseded_ids, [old.id]);
  assert.equal(old.active, false);
});

test("record bad kind refused", () => {
  const { store } = makeStore();
  const r = decide(store, { action: "record", kind: "nope", content: "x" });
  assert.ok(r.error !== undefined);
  assert.deepEqual(store.active("memory"), []);
});

test("record missing content refused", () => {
  const { store } = makeStore();
  const r = decide(store, { action: "record", kind: "memory", content: "" });
  assert.ok(r.error !== undefined);
});

test("record separator content refused", () => {
  const { store } = makeStore();
  const r = decide(store, { action: "record", kind: "memory", content: "bad § fact" });
  assert.ok(r.error !== undefined);
});

test("record ambiguous substring refused", () => {
  const { store } = makeStore();
  store.add("apples are red", "memory", "test");
  store.add("applesauce is wet", "memory", "test");
  const r = decide(store, { action: "record", kind: "memory", content: "x", supersedes: "apple" });
  assert.ok(r.error !== undefined);
});

test("retract", () => {
  const { store } = makeStore();
  const f = store.add("old fact", "memory", "test");
  const r = decide(store, { action: "retract", fact_id: f.id });
  assert.equal(r.ok, true);
  assert.equal(r.action, "retract");
  assert.equal(f.active, false);
  assert.equal(f.superseded_by, RETRACTED);
  assert.deepEqual(r.chain!.map((x) => x.content), ["old fact"]);
});

test("retract unknown id refused", () => {
  const { store } = makeStore();
  const r = decide(store, { action: "retract", fact_id: "nope" });
  assert.ok(r.error !== undefined);
});

test("retract missing id refused", () => {
  const { store } = makeStore();
  const r = decide(store, { action: "retract" });
  assert.ok(r.error !== undefined);
});

test("retract inactive refused", () => {
  const { store } = makeStore();
  const f = store.add("x", "memory", "test");
  store.retract(f.id);
  const r = decide(store, { action: "retract", fact_id: f.id });
  assert.ok(r.error !== undefined);
});

test("unknown action refused", () => {
  const { store } = makeStore();
  const r = decide(store, { action: "frobnicate" });
  assert.ok(r.error !== undefined);
});

test("dry run does not persist", () => {
  const { path, store } = makeStore();
  decide(store, { action: "record", kind: "memory", content: "no persist" }, false);
  const s2 = new MemoryStore(path);
  assert.ok(!s2.active("memory").some((f) => f.content === "no persist"));
});
