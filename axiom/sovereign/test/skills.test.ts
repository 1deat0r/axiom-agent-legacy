// Tests for the native skill store + skill bridge.
// TypeScript port of 3v0/tests/test_skills.py.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applySkillOp } from "../src/skill_bridge.ts";
import { ABSORBED, RETRACTED, SkillStore } from "../src/skills.ts";

function makeStore(): { path: string; store: SkillStore } {
  const dir = mkdtempSync(join(tmpdir(), "axiom-skills-"));
  const path = join(dir, "skills.json");
  return { path, store: new SkillStore(path) };
}

// -- SkillStore ----------------------------------------------------------

test("add starts lineage", () => {
  const { store } = makeStore();
  const v = store.add("foo", "create", "assistant_tool", "---\nname: foo\n");
  assert.equal(v.active, true);
  assert.deepEqual(v.supersedes, []);
  assert.deepEqual(store.activeNames(), new Set(["foo"]));
});

test("patch supersedes previous", () => {
  const { store } = makeStore();
  const v1 = store.add("foo", "create", "assistant_tool", "v1");
  const v2 = store.add("foo", "patch", "background_review", "", "", "", "patch 'a' -> 'b'");
  assert.equal(v1.active, false);
  assert.equal(v1.superseded_by, v2.id);
  assert.deepEqual(v2.supersedes, [v1.id]);
  assert.equal(store.latestActive("foo"), v2);
});

test("history returns full lineage", () => {
  const { store } = makeStore();
  const v1 = store.add("foo", "create", "a", "v1");
  const v2 = store.add("foo", "edit", "b", "v2");
  const v3 = store.add("foo", "edit", "c", "v3");
  assert.deepEqual(store.history("foo").map((x) => x.id), [v1.id, v2.id, v3.id]);
});

test("retract is terminal and recoverable", () => {
  const { store } = makeStore();
  const v = store.add("foo", "create", "a", "x");
  const r = store.retract("foo", "background_review");
  assert.equal(r, v);
  assert.equal(v.active, false);
  assert.equal(v.superseded_by, RETRACTED);
  assert.deepEqual(store.activeNames(), new Set());
  assert.equal(store.latestActive("foo"), null);
  assert.deepEqual(store.history("foo").map((x) => x.id), [v.id]);
});

test("absorb records umbrella", () => {
  const { store } = makeStore();
  const v = store.add("old-skill", "create", "a", "x");
  const r = store.absorb("old-skill", "umbrella", "curator");
  assert.equal(r, v);
  assert.equal(v.superseded_by, ABSORBED);
  assert.equal(v.absorbed_into, "umbrella");
  assert.equal(store.latestActive("old-skill"), null);
  assert.deepEqual(store.absorbedBy("umbrella"), ["old-skill"]);
});

test("recreate after retract starts fresh chain", () => {
  const { store } = makeStore();
  const v1 = store.add("foo", "create", "a", "v1");
  store.retract("foo");
  const v2 = store.add("foo", "create", "b", "v2");
  assert.deepEqual(v2.supersedes, []);
  assert.equal(v2.active, true);
  assert.equal(v1.active, false);
  assert.deepEqual(new Set(store.history("foo").map((x) => x.id)), new Set([v1.id, v2.id]));
});

test("retract missing returns null", () => {
  const { store } = makeStore();
  assert.equal(store.retract("nope"), null);
  assert.equal(store.absorb("nope", "x"), null);
});

test("add rejects terminal action", () => {
  const { store } = makeStore();
  assert.throws(() => store.add("foo", "delete", "a"));
});

test("add rejects unknown action", () => {
  const { store } = makeStore();
  assert.throws(() => store.add("foo", "frobnicate", "a"));
});

test("active excludes absorbed", () => {
  const { store } = makeStore();
  store.add("keep", "create", "a", "k");
  store.add("gone", "create", "a", "g");
  store.absorb("gone", "keep");
  assert.deepEqual(store.activeNames(), new Set(["keep"]));
});

test("persists and mutate reloads", () => {
  const { path } = makeStore();
  const s1 = new SkillStore(path);
  s1.add("foo", "create", "a", "v1");
  const s2 = new SkillStore(path);
  s1.add("foo", "edit", "b", "v2");
  assert.equal(s2.latestActive("foo")!.content, "v1");
  s2.mutate(() => {
    assert.equal(s2.latestActive("foo")!.content, "v2");
  });
});

// -- SkillState ----------------------------------------------------------

test("state defaults active", () => {
  const { store } = makeStore();
  assert.equal(store.state("foo"), "active");
  assert.deepEqual(store.stateHistory("foo"), []);
});

test("set state records transition", () => {
  const { store } = makeStore();
  const ev = store.setState("foo", "stale", "curator")!;
  assert.equal(ev.from, "active");
  assert.equal(ev.state, "stale");
  assert.equal(ev.source, "curator");
  assert.equal(store.state("foo"), "stale");
  assert.deepEqual(store.stateHistory("foo").map((e) => e.state), ["stale"]);
});

test("set state is idempotent", () => {
  const { store } = makeStore();
  store.setState("foo", "stale", "curator");
  assert.equal(store.setState("foo", "stale", "curator"), null);
  assert.equal(store.stateHistory("foo").length, 1);
});

test("state chain records full history", () => {
  const { store } = makeStore();
  store.setState("foo", "stale", "curator");
  store.setState("foo", "archived", "curator");
  store.setState("foo", "active", "curator");
  assert.equal(store.state("foo"), "active");
  assert.deepEqual(store.stateHistory("foo").map((e) => e.state), ["stale", "archived", "active"]);
});

test("set state rejects unknown", () => {
  const { store } = makeStore();
  assert.throws(() => store.setState("foo", "banana"));
});

test("state persists roundtrip", () => {
  const { path } = makeStore();
  const s1 = new SkillStore(path);
  s1.setState("foo", "archived", "curator");
  const s2 = new SkillStore(path);
  assert.equal(s2.state("foo"), "archived");
  assert.equal(s2.stateHistory("foo")[0]!.state, "archived");
});

test("state orthogonal to content active", () => {
  const { store } = makeStore();
  store.add("foo", "create", "a", "c");
  store.setState("foo", "archived", "curator");
  assert.notEqual(store.latestActive("foo"), null);
  assert.ok(store.activeNames().has("foo"));
});

// -- SkillBridge ---------------------------------------------------------

test("create", () => {
  const { store } = makeStore();
  const n = applySkillOp(store, { action: "create", name: "foo", content: "---\nname: foo\n" }, "assistant_tool");
  assert.equal(n, 1);
  const v = store.latestActive("foo")!;
  assert.equal(v.action, "create");
  assert.equal(v.source, "assistant_tool");
  assert.ok(v.content.includes("name: foo"));
});

test("create idempotent", () => {
  const { store } = makeStore();
  applySkillOp(store, { action: "create", name: "foo", content: "c" }, "a");
  const n = applySkillOp(store, { action: "create", name: "foo", content: "c" }, "b");
  assert.equal(n, 0);
  assert.equal(store.versions("foo").length, 1);
});

test("patch records note not content", () => {
  const { store } = makeStore();
  applySkillOp(store, { action: "create", name: "foo", content: "v1" }, "a");
  const n = applySkillOp(
    store,
    { action: "patch", name: "foo", old_string: "old", new_string: "new" },
    "background_review",
  );
  assert.equal(n, 1);
  const v = store.latestActive("foo")!;
  assert.equal(v.action, "patch");
  assert.equal(v.content, "");
  assert.ok(v.note.includes("old"));
  assert.ok(v.note.includes("new"));
});

test("patch carries resolved content when supplied", () => {
  const { store } = makeStore();
  applySkillOp(store, { action: "create", name: "foo", content: "v1" }, "a");
  const n = applySkillOp(
    store,
    { action: "patch", name: "foo", old_string: "old", new_string: "new", content: "v1-patched" },
    "background_review",
  );
  assert.equal(n, 1);
  const v = store.latestActive("foo")!;
  assert.equal(v.action, "patch");
  assert.equal(v.content, "v1-patched");
});

test("edit records full content", () => {
  const { store } = makeStore();
  applySkillOp(store, { action: "create", name: "foo", content: "v1" }, "a");
  applySkillOp(store, { action: "edit", name: "foo", content: "v2" }, "b");
  assert.equal(store.latestActive("foo")!.content, "v2");
});

test("write file records content and path", () => {
  const { store } = makeStore();
  applySkillOp(store, { action: "create", name: "foo", content: "c" }, "a");
  const n = applySkillOp(
    store,
    { action: "write_file", name: "foo", file_path: "scripts/x.py", file_content: "print(1)" },
    "a",
  );
  assert.equal(n, 1);
  const v = store.latestActive("foo")!;
  assert.equal(v.file_path, "scripts/x.py");
  assert.equal(v.content, "print(1)");
});

test("remove file records path", () => {
  const { store } = makeStore();
  applySkillOp(store, { action: "create", name: "foo", content: "c" }, "a");
  applySkillOp(store, { action: "remove_file", name: "foo", file_path: "scripts/x.py" }, "a");
  const v = store.latestActive("foo")!;
  assert.equal(v.action, "remove_file");
  assert.ok(v.note.includes("scripts/x.py"));
});

test("delete without target retracts", () => {
  const { store } = makeStore();
  const v = store.add("foo", "create", "a", "c");
  const n = applySkillOp(store, { action: "delete", name: "foo" }, "background_review");
  assert.equal(n, 1);
  assert.equal(v.superseded_by, RETRACTED);
});

test("delete with absorbed into absorbs", () => {
  const { store } = makeStore();
  const v = store.add("foo", "create", "a", "c");
  const n = applySkillOp(store, { action: "delete", name: "foo", absorbed_into: "bar" }, "curator");
  assert.equal(n, 1);
  assert.equal(v.superseded_by, ABSORBED);
  assert.equal(v.absorbed_into, "bar");
  assert.deepEqual(store.absorbedBy("bar"), ["foo"]);
});

test("missing name or bad action skipped", () => {
  const { store } = makeStore();
  assert.equal(applySkillOp(store, { action: "create" }, "a"), 0);
  assert.equal(applySkillOp(store, { action: "nope", name: "foo" }, "a"), 0);
  assert.equal(applySkillOp(store, "not a dict", "a"), 0);
  assert.deepEqual(store.allVersions(), []);
});
