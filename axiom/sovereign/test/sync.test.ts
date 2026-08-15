// Tests for store<->profile sync.
// TypeScript port of 3v0/tests/test_sync.py.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemoryStore } from "../src/memory.ts";
import { joinEntries, splitEntries } from "../src/profile_io.ts";
import { isClean, profileText, syncKind } from "../src/sync.ts";

function makeStore(): { path: string; store: MemoryStore } {
  const dir = mkdtempSync(join(tmpdir(), "axiom-sync-"));
  const path = join(dir, "mem.json");
  return { path, store: new MemoryStore(path) };
}

test("no drift reports clean", () => {
  const { store } = makeStore();
  store.add("fact a", "memory", "test");
  const r = syncKind(store, joinEntries(["fact a"]), "memory", false);
  assert.equal(isClean(r), true);
  assert.deepEqual(r.imported, []);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.exported, []);
});

test("imports profile only entry", () => {
  const { store } = makeStore();
  store.add("fact a", "memory", "test");
  const md = joinEntries(["fact a", "brand new from profile"]);
  const r = syncKind(store, md, "memory", true);
  assert.ok(r.imported.includes("brand new from profile"));
  assert.ok(store.active("memory").some((f) => f.content === "brand new from profile"));
});

test("drops superseded entry", () => {
  const { store } = makeStore();
  const old = store.add("gh = mustbearnold", "memory", "test");
  store.add("gh = 1deat0r", "memory", "test", [old.id]);
  const md = joinEntries(["gh = mustbearnold"]);
  const r = syncKind(store, md, "memory", false);
  assert.ok(r.dropped.includes("gh = mustbearnold"));
  assert.deepEqual(r.imported, []);
  assert.equal(profileText(store, "memory"), joinEntries(["gh = 1deat0r"]));
});

test("exports store only fact", () => {
  const { store } = makeStore();
  store.add("store only fact", "memory", "test");
  const md = joinEntries(["profile only fact"]);
  const r = syncKind(store, md, "memory", true);
  assert.ok(r.exported.includes("store only fact"));
  assert.ok(r.imported.includes("profile only fact"));
  assert.deepEqual(splitEntries(profileText(store, "memory")), [
    "store only fact",
    "profile only fact",
  ]);
});
